"use strict";

// ============================================================
// MATCH STATE: SNAPSHOTS, DELTAS AND THE ROLLING STATE HASH
//
// Snapshot: the whole simulation state between two ticks. Restoring one
// gives a world that evolves exactly like the one it was taken from, so a
// resync only touches the peer that diverged. (Caches whose hits change
// outcomes are dropped by every peer on the resync tick instead of being
// sent: see snapFlushHistoryCaches.)
//
// Regions: entities are grouped by the map region they are in (units by
// position, so a divergence spreading to nearby entities stays in nearby
// regions). Players, projectiles, globals, the grid and each list's order
// are parts of their own.
//
// Rolling state hash (snapTickHash): every tick, each peer hashes the
// entities of one slice of the regions (the fields that drive behaviour) and
// the small parts, so every entity is checked every SNAP_HASH_SLICES ticks at
// a small, steady cost. When a guest's hash differs from the host's, it sends
// its last rotation of hashes; the host compares them with its own and sends
// back the entities of the differing regions and the regions around them
// (snapEncodeState({ buckets })), which the guest patches in place.
//
// Encoding, built to stay cheap with thousands of entities:
// - Entities are rows listing only the fields that differ from a template
//   (the first entity of the same type and property layout, stored in full).
// - Per property layout, encoders and writers are generated once.
// - Everything derivable stays out: stat tables are pointers into the
//   per-player stat map (rebuilt only for players whose research changed),
//   definitions are pointers, indexes (tiles, spatial hash, drop grid, laser
//   links, worker reservations) are rebuilt, and a unit's path is sent from
//   its current step on (earlier steps are never read again).
//
// Values: numbers, strings, booleans and null are themselves; strings that
// start with '~' carry the rest:
//   ~          undefined          ~N ~I ~J ~Z   NaN, Infinity, -Infinity, -0
//   ~~text     a string starting with '~'
//   ~u<id>     unit               ~t / ~b / ~s <gx>,<gy>  tower / barrack / spawner
//   ~f / ~g / ~a / ~d <gx>,<gy>  floor item / gold mine / A* mine / dropped item
//   ~p<i> ~P<i>  projectile / player      ~o<i>  pooled object (keeps identity)
//   ~M<player>,<u|b>,<key>,<level>  stat map entry     ~Ku<key> ~Kb<key>  definition
// Pooled objects hold every other object: arrays, plain objects, maps, sets,
// entities no longer in their list.
// ============================================================

const SNAP_FORMAT = 7;
const SNAP_TILDE = 126;
const SNAP_REGION_TILES = 4;
const SNAP_HASH_SLICES = 10;

// Render, audio and index bookkeeping: rebuilt or irrelevant after restore.
const SNAP_SKIP_KEYS = new Set([
    'textCtx', 'textCanvas', '_textCanvasScale', '_levelTextLabel', 'prevX', 'prevY',
    '_spatialKey', '_spatialAreaId', '_spatialAreaOwner', '_spatialUnitTypeIdx', '_spatialLastVisScaled',
    '_damageFlashStart', '_damageFlashUntil', '_damageFlashStrength', '_damageFlashColor', '_ambientSoundTicks',
    '_historyGhost', '_historyTick', '_droppedIndex', '_areaBucketId'
]);

// Lists: P players, u units, t towers, b barracks, s spawners, f floor
// items, g gold mines, a A* mines, d dropped items, p projectiles.
const SNAP_LISTS = ['P', 'u', 't', 'b', 's', 'f', 'g', 'a', 'd', 'p'];
const SNAP_LIST_CODE = { P: 0, u: 1, t: 2, b: 3, s: 4, f: 5, g: 6, a: 7, d: 8, p: 9 };
const SNAP_REGION_LISTS = ['u', 't', 'b', 's', 'f', 'g', 'a', 'd'];
const SNAP_ORDER_LISTS = ['u', 't', 'b', 's', 'g', 'a', 'd'];
// Hash codes: part * 2^24 + index. Regions are part 0.
const SNAP_CODE_SHIFT = 16777216;
const SNAP_PART_REGION = 0;
const SNAP_PART_PLAYERS = 1;
const SNAP_PART_PROJECTILES = 2;
const SNAP_PART_GLOBALS = 3;
const SNAP_PART_GRID = 4;
const SNAP_PART_ORDER = 5;

// ---------------------------------------------------------------------------
// Entity lists, keys and regions
// ---------------------------------------------------------------------------
function _snapIsBuilding(e) {
    return e instanceof Tower || e instanceof Barrack || isSpawnerEntity(e);
}

function _snapFloorItems() {
    let out = [];
    for (let item of getCellItemsRowMajor()) {
        if (!item || _snapIsBuilding(item)) continue;
        let cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item) continue;
        out.push(item);
    }
    return out;
}

function _snapListEntities(list) {
    switch (list) {
        case 'u': return units;
        case 't': return towers;
        case 'b': return barracks;
        case 's': return collectorSpawners;
        case 'f': return _snapFloorItems();
        case 'g': return goldMines;
        case 'a': return astarMines;
        case 'd': return droppedItems;
        case 'p': return projectiles;
        case 'P': return players;
    }
    return [];
}

// Identity key of an entity: the same on every peer.
function _snapEntityKey(list, e, index) {
    if (list === 'u') return e.id;
    if (list === 'p' || list === 'P') return index;
    return e.gx + ',' + e.gy;
}

function _snapRegion(gx, gy) {
    return Math.floor(gy / SNAP_REGION_TILES) * 1024 + Math.floor(gx / SNAP_REGION_TILES);
}

// A unit's region from its position. Every peer, and the hash and the
// encoder alike, use this one formula.
function _snapUnitRegion(u) {
    let ts = TILE * SNAP_REGION_TILES;
    return Math.floor(u.y / ts) * 1024 + Math.floor(u.x / ts);
}

function _snapRegionOf(list, e) {
    if (list === 'u') return _snapUnitRegion(e);
    return _snapRegion(e.gx, e.gy);
}

function _snapTypeKey(list, e) {
    if (list === 'u' || list === 'b') return e.unitType;
    if (list === 't' || list === 's' || list === 'f') return e.type;
    return '';
}

let _snapUnitShellMode = false;

function _snapSpawnerClass(type) {
    switch (type) {
        case 'astar_spawner': return AstarSpawner;
        case 'salvager': return SalvagerSpawner;
        case 'builder_spawner': return BuilderSpawner;
        case 'healer_spawner': return HealerSpawner;
        case 'research': return ResearchSpawner;
    }
    return CollectorSpawner;
}

function _snapNewShell(list, typeKey) {
    switch (list) {
        case 'u': {
            // Constructed for the shared unit layout; in shell mode the
            // constructor skips its stat and spatial setup.
            let savedId = nextUnitId;
            _snapUnitShellMode = true;
            try { return new Unit(typeof typeKey === 'string' && typeKey ? typeKey : 'norm', 0, 0, 0); }
            finally { _snapUnitShellMode = false; nextUnitId = savedId; }
        }
        case 't': return Object.create(Tower.prototype);
        case 'b': return Object.create(Barrack.prototype);
        case 's': return Object.create(_snapSpawnerClass(typeKey).prototype);
        case 'p': return Object.create(Projectile.prototype);
    }
    return {};
}

function _snapClassByName(name) {
    switch (name) {
        case 'Unit': return Unit;
        case 'Tower': return Tower;
        case 'Barrack': return Barrack;
        case 'Projectile': return Projectile;
        case 'CollectorSpawner': return CollectorSpawner;
        case 'AstarSpawner': return AstarSpawner;
        case 'SalvagerSpawner': return SalvagerSpawner;
        case 'BuilderSpawner': return BuilderSpawner;
        case 'HealerSpawner': return HealerSpawner;
        case 'ResearchSpawner': return ResearchSpawner;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
const _snapF64 = new Float64Array(1);
const _snapI32 = new Int32Array(_snapF64.buffer);
const _snapStrCodes = new Map();

function _snapStrCode(s) {
    let c = _snapStrCodes.get(s);
    if (c !== undefined) return c;
    c = 2166136261 | 0;
    for (let i = 0; i < s.length; i++) c = Math.imul(c ^ s.charCodeAt(i), 16777619);
    c = Math.imul(c ^ 0x9e37, 16777619);
    if (_snapStrCodes.size > 50000) _snapStrCodes.clear();
    _snapStrCodes.set(s, c);
    return c;
}

function _snapHNum(h, x) {
    // NaN bit patterns can differ between operations and engines.
    if (x !== x) return Math.imul(h ^ 0x7ff8, 16777619);
    _snapF64[0] = x;
    return Math.imul(Math.imul(h ^ _snapI32[0], 16777619) ^ _snapI32[1], 16777619);
}

// Shallow hash of an array element or object field.
function _snapHShallow(h, x) {
    switch (typeof x) {
        case 'number': return _snapHNum(h, x);
        case 'string': return Math.imul(h ^ _snapStrCode(x), 16777619);
        case 'boolean': return Math.imul(h ^ (x ? 0x3bd : 0x2bd), 16777619);
        case 'undefined': return Math.imul(h ^ 0x5bd, 16777619);
        case 'object':
            if (x === null) return Math.imul(h ^ 0x7bd, 16777619);
            if (x instanceof Unit) return Math.imul(Math.imul(h ^ x.id, 16777619) ^ (x.dead ? 11 : 12), 16777619);
            if (typeof x.gx === 'number' && typeof x.gy === 'number') return Math.imul(Math.imul(h ^ x.gx, 16777619) ^ x.gy, 16777619);
            if (typeof x.x === 'number' && typeof x.y === 'number') return _snapHNum(_snapHNum(h, x.x), x.y);
            {
                let n = 0;
                for (let k in x) {
                    let y = x[k];
                    if (typeof y === 'number') h = _snapHNum(h, y);
                    else if (typeof y === 'string') h = Math.imul(h ^ _snapStrCode(y), 16777619);
                    if (++n >= 6) break;
                }
                return Math.imul(h ^ (0x9bd + n), 16777619);
            }
    }
    return h;
}

// Hash of a field value that is not a number. Objects are summarized:
// entities by identity, arrays by length and a few elements, plain objects
// by their first values (stat tables: their leading stats).
function _snapHV(h, x) {
    switch (typeof x) {
        case 'string': return Math.imul(h ^ _snapStrCode(x), 16777619);
        case 'boolean': return Math.imul(h ^ (x ? 0x3bd : 0x2bd), 16777619);
        case 'object': {
            if (x === null) return Math.imul(h ^ 0x7bd, 16777619);
            if (Array.isArray(x)) {
                let n = x.length;
                h = Math.imul(h ^ n, 16777619);
                if (n > 0) { h = _snapHShallow(h, x[0]); if (n > 1) h = _snapHShallow(h, x[n - 1]); if (n > 2) h = _snapHShallow(h, x[n >> 1]); }
                return h;
            }
            return _snapHShallow(h, x);
        }
    }
    return Math.imul(h ^ 0x5bd, 16777619);
}

// A unit's path: its length and the steps around the current one (the only
// ones the simulation reads again).
function _snapHPath(h, o) {
    let p = o.path;
    if (!Array.isArray(p)) return _snapHV(h, p);
    let i = o.pathIndex | 0;
    h = Math.imul(h ^ p.length, 16777619);
    for (let k = i - 1; k <= i + 1; k++) if (k >= 0 && k < p.length) h = _snapHShallow(h, p[k]);
    if (p.length > 0) h = _snapHShallow(h, p[p.length - 1]);
    return h;
}

// Fields that drive behaviour, hashed every rotation (a patch sends every
// field of an entity, so the rest is repaired along with these).
const SNAP_HASH_FIELDS = {
    u: ['owner', 'unitType', 'x', 'y', 'vx', 'vy', 'energy', 'maxEnergy', 'attackTimer', 'commandState', 'holdPosition', 'forcedAttackTarget',
        'targetUnit', 'targetBuilding', 'targetPos', 'path', '_pendingPathTarget', 'pathIsFallbackAstar', '_attackMoveGx', '_attackMoveGy',
        'stackCount', 'effectiveStacks', 'unitLevel', 'effectiveLevel', 'dead', 'teleportHideTicks',
        'poisoned', 'burning', 'frozen', 'wet', 'sandy', 'watched', 'watchedByTeam',
        'workerState', 'workerTarget', 'workerTargetType', 'carryingValue', 'workerTransferCooldown', '_workerReservedTileIndex',
        'builderHasMaterial', 'healerHasMaterial', 'researcherHasMaterial', '_workerNextIdleRetargetTick', '_astarBudgetRetryTick', '_scoutTarget'],
    b: ['owner', 'type', 'unitType', 'energy', 'maxEnergy', 'stacks', 'manualStacks', 'level', 'effectiveLevel', 'effectiveStacks',
        'stackingWorkDone', 'isStacking', 'underConstruction', 'isUpgrading', 'buildProgress', 'markedForSalvage',
        'autoUpgradeEnabled', 'autoStackEnabled', 'buildEnabled', 'queueEnabled', 'autoResearchEnabled', 'isResearching', 'researchTask',
        'spawnTimer', 'spawnCooldown', 'spawnQueue', 'cd', 'laserState', 'laserTimer', 'preferredTarget',
        'rallyX', 'rallyY', 'rallyTargetUnitId', 'burning', 'poisoned', 'frozen', 'wet', 'sandy', 'watched', 'watchedByTeam'],
    m: ['gold', 'astar', 'maxGold', 'maxAstar'],
    d: ['type', 'value', 'timer'],
    p: ['x', 'y', 'vx', 'vy', 'life', 'dmg', 'level', 'type', 'sx', 'sy', 'sourceOwner']
};

// Generated per field list. Integers (most fields) skip the float bits;
// strings reuse the last hash seen in the same field.
function _snapMakeFieldHasher(fields) {
    let body = 'let x, v;\n' + fields.map((k, i) => {
        let kc = _snapStrCode(k);
        let acc = 'o[' + JSON.stringify(k) + ']';
        if (k === 'path') return 'x = o.path; if (x !== undefined) { v = P(' + kc + ', o); h = (h + Math.imul(v, 2654435761)) | 0; }';
        return 'x = ' + acc + '; if (x !== undefined) {'
            + ' if (typeof x === "number") { if ((x | 0) === x && (x !== 0 || 1 / x > 0)) v = Math.imul(' + kc + ' ^ x, 16777619); else if (x !== x) v = ' + kc + ' ^ 0x7ff8; else { F[0] = x; v = Math.imul(Math.imul(' + kc + ' ^ I[0], 16777619) ^ I[1], 0x5bd1e995); } }'
            + ' else if (typeof x === "string") { if (x !== S[' + i + ']) { S[' + i + '] = x; C[' + i + '] = Math.imul(' + kc + ' ^ _snapStrCode(x), 16777619); } v = C[' + i + ']; }'
            + ' else v = V(' + kc + ', x);'
            + ' h = (h + Math.imul(v, 2654435761)) | 0; }';
    }).join('\n') + '\nreturn h;';
    let S = new Array(fields.length).fill(undefined), C = new Array(fields.length).fill(0);
    return new Function('S', 'C', '_snapStrCode', 'return function (o, h, F, I, V, P) {\n' + body + '\n};')(S, C, _snapStrCode);
}

const _snapHashers = {
    u: _snapMakeFieldHasher(SNAP_HASH_FIELDS.u),
    b: _snapMakeFieldHasher(SNAP_HASH_FIELDS.b),
    m: _snapMakeFieldHasher(SNAP_HASH_FIELDS.m),
    d: _snapMakeFieldHasher(SNAP_HASH_FIELDS.d),
    p: _snapMakeFieldHasher(SNAP_HASH_FIELDS.p)
};

function _snapHashEntity(kind, e, seed) {
    let h = _snapHashers[kind](e, seed | 0, _snapF64, _snapI32, _snapHV, _snapHPath);
    return Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
}

// Full hash of a small object tree (players).
function _snapHDeep(h, x, depth) {
    if (x === null || typeof x !== 'object') return typeof x === 'number' ? _snapHNum(h, x) : _snapHV(h, x);
    if (depth <= 0 || x instanceof Unit) return _snapHV(h, x);
    if (Array.isArray(x)) {
        h = Math.imul(h ^ x.length, 16777619);
        for (let i = 0; i < x.length; i++) h = _snapHDeep(h, x[i], depth - 1);
        return h;
    }
    for (let k in x) {
        let y = x[k];
        if (y === undefined) continue;
        h = Math.imul(h ^ _snapStrCode(k), 16777619);
        h = _snapHDeep(h, y, depth - 1);
    }
    return h;
}

function _snapHashGlobals() {
    let h = 2166136261 | 0;
    h = _snapHNum(h, gameTime);
    h = _snapHNum(h, nextUnitId);
    h = _snapHV(h, !!gameOver);
    h = _snapHDeep(h, winner, 1);
    h = _snapHDeep(h, pendingPathResolveCursor, 1);
    h = _snapHDeep(h, globalSpawnerReadyOrderCounter, 1);
    h = _snapHDeep(h, (rng && typeof rng.getState === 'function') ? rng.getState() : null, 1);
    if (pathfindBudgetByPlayer) for (let i = 0; i < pathfindBudgetByPlayer.length; i++) h = _snapHNum(h, pathfindBudgetByPlayer[i]);
    if (astarNodeBudgetRemainingByPlayer) for (let i = 0; i < astarNodeBudgetRemainingByPlayer.length; i++) h = _snapHNum(h, astarNodeBudgetRemainingByPlayer[i]);
    for (let ar of (areas || [])) if (ar) { h = _snapHV(h, !!ar.active); h = _snapHDeep(h, ar.multiplierLevel, 1); }
    let resigned = 0;
    for (let t of (resignedTeams || [])) resigned = (resigned + Math.imul((t | 0) + 1, 2654435761)) | 0;
    h = Math.imul(h ^ resigned, 16777619);
    for (let t of (activeTeamIds || [])) h = Math.imul(h ^ ((t | 0) + 1), 16777619);
    h = _snapHV(h, !!_adjacencyPassiveRefreshMode);
    h = Math.imul(h ^ _pendingResourceStatRebuilds.size, 16777619);
    h = _snapHV(h, !!_adjacencyNeedsRecalc);
    h = _snapHV(h, !!_adjacencyDirtyAll);
    h = _snapHDeep(h, _adjacencyLastRecalcTick, 1);
    let dirty = 0;
    for (let k of (_adjacencyDirtyTiles || [])) dirty = (dirty + Math.imul((k | 0) + 1, 2654435761)) | 0;
    h = Math.imul(Math.imul(h ^ dirty, 16777619) ^ (_adjacencyDirtyTiles ? _adjacencyDirtyTiles.size : 0), 16777619);
    return h >>> 0;
}

// Membership and order of one list.
function _snapHashOrder(list) {
    let h = 2166136261 | 0;
    if (list === 'u') { for (let u of units) h = Math.imul(h ^ u.id, 16777619); }
    else for (let e of _snapListEntities(list)) h = Math.imul(Math.imul(h ^ e.gx, 16777619) ^ e.gy, 16777619);
    return h >>> 0;
}

let _snapStaticSliceCache = null;

// Per slice: [entity, hasher kind, seed, region, ...] for every building,
// floor item and mine, rebuilt when the tile index changes.
function _snapStaticSlices() {
    let c = _snapStaticSliceCache;
    if (c && c.version === _tileEntityVersion && c.towers === towers && c.towersLength === towers.length
        && c.barracks === barracks && c.barracksLength === barracks.length && c.spawners === collectorSpawners
        && c.spawnersLength === collectorSpawners.length && c.gold === goldMines.length && c.astar === astarMines.length) return c.slices;
    let rt = SNAP_REGION_TILES;
    let slices = Array.from({ length: SNAP_HASH_SLICES }, () => []);
    let put = (e, kind, code) => {
        let r = Math.floor(e.gy / rt) * 1024 + Math.floor(e.gx / rt);
        slices[r % SNAP_HASH_SLICES].push(e, kind, (Math.imul(e.gx, 4099) + e.gy) ^ code, r);
    };
    for (let e of towers) put(e, 'b', 0x22);
    for (let e of barracks) put(e, 'b', 0x33);
    for (let e of collectorSpawners) put(e, 'b', 0x44);
    for (let e of goldMines) put(e, 'm', 0x66);
    for (let e of astarMines) put(e, 'm', 0x77);
    for (let item of getCellItemsRowMajor()) {
        if (!item || _snapIsBuilding(item)) continue;
        let cell = grid[item.gy] && grid[item.gy][item.gx];
        if (!cell || cell.item !== item) continue;
        put(item, 'b', 0x55);
    }
    _snapStaticSliceCache = {
        version: _tileEntityVersion, towers, towersLength: towers.length, barracks, barracksLength: barracks.length,
        spawners: collectorSpawners, spawnersLength: collectorSpawners.length, gold: goldMines.length, astar: astarMines.length, slices
    };
    return slices;
}

// Worker reservations (target tile and worker type -> unit). The table is
// state of its own: it keeps entries its units no longer point at (a target
// dropped without releasing it, a unit that has since died and left the
// list), and those still turn other workers away. So it is hashed and sent
// per region of the target tile, not rebuilt from the units.
function _snapReservationRegion(slot) {
    let tile = Math.floor(slot / _WORKER_TARGET_LOAD_TYPE_COUNT);
    return Math.floor(Math.floor(tile / GRID_W) / SNAP_REGION_TILES) * 1024 + Math.floor((tile % GRID_W) / SNAP_REGION_TILES);
}

function _snapReservationHash(slot, u) {
    let h = Math.imul((slot + 1) ^ Math.imul((Number(u.id) | 0) + 0x3c6ef372, 2654435761), 2246822519) ^ (u.dead ? 0x6b43a9b5 : 0x1b873593);
    return Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
}

// fn(slot, unit) for the entries whose target tile is in region r.
function _snapForRegionReservations(r, fn) {
    let table = workerReservedTiles, n = _WORKER_TARGET_LOAD_TYPE_COUNT, rt = SNAP_REGION_TILES;
    let ry = Math.floor(r / 1024), rx = r - ry * 1024;
    let gx0 = rx * rt, gx1 = Math.min(GRID_W, gx0 + rt);
    if (!table || gx0 >= gx1) return;
    for (let gy = ry * rt, gy1 = Math.min(GRID_H, gy + rt); gy < gy1; gy++) {
        for (let slot = (gy * GRID_W + gx0) * n, end = (gy * GRID_W + gx1) * n; slot < end; slot++) {
            let u = table[slot];
            if (u) fn(slot, u);
        }
    }
}

// fn(slot, unit, region) for every entry, or (slice >= 0) for the entries of
// that hash slice's regions only (a tenth of the table).
function _snapForReservations(slice, fn) {
    let table = workerReservedTiles;
    if (!table || table.length === 0) return;
    if (slice < 0) {
        for (let slot = 0; slot < table.length; slot++) {
            let u = table[slot];
            if (u) fn(slot, u, _snapReservationRegion(slot));
        }
        return;
    }
    let rt = SNAP_REGION_TILES, rw = Math.ceil(GRID_W / rt), rh = Math.ceil(GRID_H / rt);
    for (let ry = 0; ry < rh; ry++) {
        // region = ry * 1024 + rx, and 1024 = 4 (mod 10)
        let rx0 = (((slice - 4 * ry) % SNAP_HASH_SLICES) + SNAP_HASH_SLICES) % SNAP_HASH_SLICES;
        for (let rx = rx0; rx < rw; rx += SNAP_HASH_SLICES) {
            let r = ry * 1024 + rx;
            _snapForRegionReservations(r, (slot, u) => fn(slot, u, r));
        }
    }
}

// An entry as [slot, unit]: a unit still in the list by reference, one that
// has left it (dead) by its id.
function _snapEncodeReservation(out, slot, u) {
    out.push(slot, _snapRootRef(u) === null ? (Number(u.id) || 0) : _snapE(u));
}

// Restores the table from [slot, unit, ...]. A partial restore first drops
// what it replaces: entries on the carried regions' tiles and entries of the
// units it carries (the patch holds all of those); entries of units it
// removes stay as entries of a dead unit (as the host holds them once the
// unit has left its list).
function _snapDecodeReservations(enc, partial = null) {
    let table = workerReservedTiles;
    let gone = new Map();
    let placeholder = id => {
        let p = gone.get(id);
        if (p === undefined) gone.set(id, p = { id, dead: true, _workerReservedTileIndex: -1 });
        return p;
    };
    if (partial && (partial.regions.size > 0 || partial.carried.length > 0 || partial.removed.length > 0)) {
        let drop = new Set(partial.carried), ids = new Set(), left = new Set();
        for (let u of partial.carried) ids.add(u.id);
        for (let u of partial.removed) if (ids.has(u.id)) drop.add(u); else left.add(u);
        let regions = partial.regions;
        for (let slot = 0; slot < table.length; slot++) {
            let u = table[slot];
            if (!u) continue;
            if (drop.has(u) || regions.has(_snapReservationRegion(slot))) table[slot] = null;
            else if (left.has(u)) table[slot] = placeholder(Number(u.id) || 0);
        }
    }
    if (!Array.isArray(enc)) return;
    for (let j = 0; j + 1 < enc.length; j += 2) {
        let slot = enc[j];
        if (!(Number.isInteger(slot) && slot >= 0 && slot < table.length)) continue;
        let x = enc[j + 1];
        let u = typeof x === 'number' ? placeholder(x) : _snapD(x);
        table[slot] = (u && typeof u === 'object') ? u : null;
    }
}

// Hashes one slice of the regions (or all of them) and the small parts.
// Returns { tick, sum, pairs: [code, hash, ...] }.
function snapTickHash(tick, allSlices = false) {
    let t = Math.floor(tick);
    let slice = ((t % SNAP_HASH_SLICES) + SNAP_HASH_SLICES) % SNAP_HASH_SLICES;
    let pairs = [];
    let sum = 0;
    let push = (code, h) => {
        pairs.push(code, h);
        sum = (sum + Math.imul(h ^ Math.imul(code + 1, 2654435761), 2246822519)) >>> 0;
    };
    {
        let h = 2166136261 | 0;
        for (let p of players) h = _snapHDeep(h, p, 4);
        push(SNAP_PART_PLAYERS * SNAP_CODE_SHIFT, h >>> 0);
        let hp = Math.imul(2166136261 ^ projectiles.length, 16777619);
        for (let pr of projectiles) hp = Math.imul(hp ^ _snapHashEntity('p', pr, 0), 16777619);
        push(SNAP_PART_PROJECTILES * SNAP_CODE_SHIFT, hp >>> 0);
        push(SNAP_PART_GLOBALS * SNAP_CODE_SHIFT, _snapHashGlobals());
        for (let list of SNAP_ORDER_LISTS) push(SNAP_PART_ORDER * SNAP_CODE_SHIFT + SNAP_LIST_CODE[list], _snapHashOrder(list));
    }
    // Entities of this slice's regions, summed per region (order-free).
    let regions = new Map();
    let rt = SNAP_REGION_TILES, ts = TILE * SNAP_REGION_TILES;
    let hu = _snapHashers.u;
    for (let i = 0; i < units.length; i++) {
        let u = units[i];
        let r = Math.floor(u.y / ts) * 1024 + Math.floor(u.x / ts);
        if (!allSlices && (r % SNAP_HASH_SLICES) !== slice) continue;
        let h = hu(u, Math.imul(u.id, 7919) ^ 0x11, _snapF64, _snapI32, _snapHV, _snapHPath);
        h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
        let prev = regions.get(r);
        regions.set(r, prev === undefined ? h : ((prev + h) >>> 0));
    }
    // Buildings and mines never move: their slices are cached until the
    // tile index changes (something built, destroyed or depleted).
    let slices = _snapStaticSlices();
    let hashStatic = (entries) => {
        for (let j = 0; j < entries.length; j += 4) {
            let e = entries[j];
            let h = _snapHashers[entries[j + 1]](e, entries[j + 2], _snapF64, _snapI32, _snapHV, _snapHPath);
            h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
            let r = entries[j + 3];
            let prev = regions.get(r);
            regions.set(r, prev === undefined ? h : ((prev + h) >>> 0));
        }
    };
    if (allSlices) for (let k = 0; k < SNAP_HASH_SLICES; k++) hashStatic(slices[k]);
    else hashStatic(slices[slice]);
    for (let i = 0; i < droppedItems.length; i++) {
        let e = droppedItems[i];
        let r = Math.floor(e.gy / rt) * 1024 + Math.floor(e.gx / rt);
        if (!allSlices && (r % SNAP_HASH_SLICES) !== slice) continue;
        let h = _snapHashEntity('d', e, (Math.imul(e.gx, 4099) + e.gy) ^ 0x88);
        let prev = regions.get(r);
        regions.set(r, prev === undefined ? h : ((prev + h) >>> 0));
    }
    _snapForReservations(allSlices ? -1 : slice, (slot, u, r) => {
        let h = _snapReservationHash(slot, u);
        let prev = regions.get(r);
        regions.set(r, prev === undefined ? h : ((prev + h) >>> 0));
    });
    for (let [r, h] of regions) push(SNAP_PART_REGION * SNAP_CODE_SHIFT + r, h);
    // Grid rows of this slice: cell types and owners.
    {
        let h = 2166136261 | 0;
        for (let gy = allSlices ? 0 : slice; gy < GRID_H; gy += allSlices ? 1 : SNAP_HASH_SLICES) {
            let row = grid[gy];
            if (!row) continue;
            for (let gx = 0; gx < GRID_W; gx++) {
                let c = row[gx];
                h = Math.imul(Math.imul(h ^ c.type, 16777619) ^ c.owner, 16777619);
            }
        }
        push(SNAP_PART_GRID * SNAP_CODE_SHIFT, h >>> 0);
    }
    return { tick: t, sum, pairs };
}

// This peer's recent tick hashes, for comparing with another peer's.
const SNAP_HASH_HISTORY_TICKS = 200;
let _snapHashHistory = new Map();

function snapRecordTickHash(tick) {
    // Exact-lockstep debug mode hashes everything every tick: it stops at the
    // first tick anything differs and names all of it.
    let r = snapTickHash(tick, !!lockstepStrictDebugMode);
    _snapHashHistory.set(r.tick, r);
    if (_snapHashHistory.size > SNAP_HASH_HISTORY_TICKS) {
        for (let k of _snapHashHistory.keys()) {
            if (k > r.tick - SNAP_HASH_HISTORY_TICKS) break;
            _snapHashHistory.delete(k);
        }
    }
    return r;
}

function snapGetTickHash(tick) {
    return _snapHashHistory.get(Math.floor(tick)) || null;
}

// The last full rotation of recorded hashes up to `tick` (every region once).
function snapHashRotation(tick) {
    let out = [];
    for (let t = Math.floor(tick) - SNAP_HASH_SLICES + 1; t <= tick; t++) {
        let r = _snapHashHistory.get(t);
        if (r) out.push(r);
    }
    return out;
}

function snapResetHashHistory() {
    _snapHashHistory = new Map();
}

// Codes whose hashes differ between two snapTickHash results of one tick.
function snapDiffTickHash(mine, theirs) {
    let a = new Map(), b = new Map();
    let pa = (mine && mine.pairs) || [], pb = (theirs && theirs.pairs) || [];
    for (let i = 0; i < pa.length; i += 2) a.set(pa[i], pa[i + 1]);
    for (let i = 0; i < pb.length; i += 2) b.set(pb[i], pb[i + 1]);
    let out = [];
    for (let [k, h] of a) if (b.get(k) !== h) out.push(k);
    for (let k of b.keys()) if (!a.has(k)) out.push(k);
    return out;
}

// Differing codes in words, for exact-lockstep mode's stop message: the
// parts, and what the regions hold on this peer.
function snapDescribeCodes(codes, limit = 12) {
    let b = snapBucketsFromCodes(codes, 0);
    let out = [];
    if (b.players) out.push('players');
    if (b.projectiles) out.push('projectiles');
    if (b.globals) out.push('globals');
    if (b.grid) out.push('grid cells');
    for (let list of b.orders) out.push('membership of list ' + list);
    let rt = SNAP_REGION_TILES;
    for (let r of b.regions) {
        let ry = Math.floor(r / 1024), rx = r - ry * 1024;
        let things = [];
        for (let u of units) if (_snapUnitRegion(u) === r) things.push('unit ' + u.id + ' ' + u.unitType + (u.dead ? ' (dead)' : ''));
        for (let list of ['t', 'b', 's', 'f', 'g', 'a', 'd']) {
            for (let gy = ry * rt; gy < ry * rt + rt && gy < GRID_H; gy++) for (let gx = rx * rt; gx < rx * rt + rt && gx < GRID_W; gx++) {
                let e = _snapEntityAtTile(list, gx, gy);
                if (e && e.gx === gx && e.gy === gy) things.push((e.type || e.unitType || list) + ' at ' + gx + ',' + gy);
            }
        }
        out.push('tiles ' + (rx * rt) + '-' + (rx * rt + rt - 1) + ',' + (ry * rt) + '-' + (ry * rt + rt - 1) + ': ' + (things.slice(0, 6).join(', ') || 'nothing'));
    }
    return out.slice(0, limit);
}

// Differing codes -> what a delta carries: every entity in the differing
// regions and the regions around them (a divergence spreads to what is
// nearby while the fix is on its way), players, projectiles, the grid, and
// the orders of lists whose membership or order differs.
function snapBucketsFromCodes(codes, dilate = 1) {
    let out = { regions: new Set(), players: false, projectiles: false, grid: false, globals: false, orders: new Set(), count: 0 };
    let seeds = [];
    for (let code of codes) {
        let part = Math.floor(code / SNAP_CODE_SHIFT);
        let index = code - part * SNAP_CODE_SHIFT;
        out.count++;
        if (part === SNAP_PART_REGION) seeds.push(index);
        else if (part === SNAP_PART_PLAYERS) out.players = true;
        else if (part === SNAP_PART_PROJECTILES) out.projectiles = true;
        else if (part === SNAP_PART_GLOBALS) out.globals = true;
        else if (part === SNAP_PART_GRID) out.grid = true;
        else if (part === SNAP_PART_ORDER) { let list = SNAP_LISTS[index]; if (list) out.orders.add(list); }
    }
    for (let r of seeds) {
        let ry = Math.floor(r / 1024), rx = r - ry * 1024;
        for (let dy = -dilate; dy <= dilate; dy++) for (let dx = -dilate; dx <= dilate; dx++) {
            let x = rx + dx, y = ry + dy;
            if (x >= 0 && y >= 0 && x < 1024) out.regions.add(y * 1024 + x);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Generated per-layout code
// ---------------------------------------------------------------------------
const _snapShapeCache = new Map();

function _snapKeysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function _snapGetShape(keys) {
    let id = keys.join('\u0001');
    let shape = _snapShapeCache.get(id);
    if (shape) return shape;
    let cols = [];
    for (let k of keys) if (!SNAP_SKIP_KEYS.has(k)) cols.push(k);
    // A unit's path goes from its current step on (see _snapEncodePath).
    let unitPath = cols.includes('path') && cols.includes('pathIndex');
    let acc = k => '[' + JSON.stringify(k) + ']';
    let full = 'return [' + cols.map(k => (unitPath && k === 'path') ? 'EP(o)' : 'E(o' + acc(k) + ')').join(',') + '];';
    let diff = 'let v;\n' + cols.map((k, i) => (unitPath && k === 'path')
        ? 'if (o.path !== t.path || o.pathIndex !== t.pathIndex) out.push(' + i + ', EP(o));'
        : 'if ((v = o' + acc(k) + ') !== t' + acc(k) + ') out.push(' + i + ', E(v));').join('\n');
    // Every key is written in the original order (skipped ones as
    // undefined), so restored objects get the same property layout.
    let ci = 0;
    let assign = keys.map(k => SNAP_SKIP_KEYS.has(k) ? 'o' + acc(k) + ' = undefined;' : 'o' + acc(k) + ' = v[' + (ci++) + '];').join('\n');
    let fullFn = null, diffFn = null, assignFn = null;
    shape = {
        id, keys, cols,
        colIndex: new Map(cols.map((k, i) => [k, i])),
        full: (o, E, EP) => (fullFn || (fullFn = new Function('o', 'E', 'EP', full)))(o, E, EP),
        diff: (o, t, E, EP, out) => (diffFn || (diffFn = new Function('o', 't', 'E', 'EP', 'out', diff)))(o, t, E, EP, out),
        assign: (o, v) => (assignFn || (assignFn = new Function('o', 'v', assign)))(o, v),
        encGen: -1, encTpls: null, encIndex: -1
    };
    _snapShapeCache.set(id, shape);
    return shape;
}

// Shape of an entity, trying the recent ones of the same list first.
function _snapShapeOf(e, mru) {
    let keys = Object.keys(e);
    for (let i = 0; i < mru.length; i++) {
        let s = mru[i];
        if (_snapKeysEqual(keys, s.keys)) {
            if (i > 0) { mru[i] = mru[0]; mru[0] = s; }
            return s;
        }
    }
    let s = _snapGetShape(keys);
    mru.unshift(s);
    if (mru.length > 8) mru.length = 8;
    return s;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------
let _snapEnc = null;
let _snapEncGen = 0;
let _snapStatRefCache = { maps: null, index: null };

// Stat map entry -> pointer, cached while the per-player maps are the same
// objects; a pointer is checked against the map whenever it is used.
function _snapStatIndex() {
    let maps = PRECOMPUTED_STATS_MAP_PLAYER;
    let cache = _snapStatRefCache;
    let valid = !!cache.index && cache.maps.length === maps.length;
    if (valid) for (let i = 0; i < maps.length; i++) if (cache.maps[i] !== maps[i]) { valid = false; break; }
    if (valid) return cache.index;
    let index = new Map();
    for (let p = 0; p < maps.length; p++) {
        let entry = maps[p];
        if (!entry) continue;
        for (let kind of ['unit', 'building']) {
            let branch = entry[kind];
            if (!branch) continue;
            let k = kind === 'unit' ? 'u' : 'b';
            for (let key in branch) {
                let arr = branch[key];
                if (!Array.isArray(arr)) continue;
                for (let lvl = 0; lvl < arr.length; lvl++) {
                    let t = arr[lvl];
                    if (t && typeof t === 'object' && !index.has(t)) index.set(t, [p, kind, key, lvl, '~M' + p + ',' + k + ',' + key + ',' + lvl]);
                }
            }
        }
    }
    _snapStatRefCache = { maps: maps.slice(), index };
    return index;
}

function _snapStatRefString(obj, index) {
    let loc = index.get(obj);
    if (loc === undefined) return null;
    let entry = PRECOMPUTED_STATS_MAP_PLAYER[loc[0]];
    let branch = entry && entry[loc[1]];
    let arr = branch && branch[loc[2]];
    if (!arr || arr[loc[3]] !== obj) return null;
    return loc[4];
}

// Reference of an entity in its list, found from the entity itself.
function _snapRootRef(v) {
    let ctx = _snapEnc;
    if (v instanceof Unit) {
        // The unit list is in id order (ids only grow; removal splices).
        if (ctx.unitsSorted === null) {
            ctx.unitsSorted = true;
            for (let i = 1; i < units.length; i++) if (!(units[i - 1].id < units[i].id)) { ctx.unitsSorted = false; break; }
        }
        if (ctx.unitsSorted) {
            let lo = 0, hi = units.length - 1, id = v.id;
            while (lo <= hi) {
                let mid = (lo + hi) >> 1, mv = units[mid].id;
                if (mv === id) return units[mid] === v ? '~u' + id : null;
                if (mv < id) lo = mid + 1; else hi = mid - 1;
            }
            return null;
        }
        if (!ctx.unitSet) ctx.unitSet = new Set(units);
        return ctx.unitSet.has(v) ? '~u' + v.id : null;
    }
    let gx = v.gx, gy = v.gy;
    if (typeof gx === 'number' && typeof gy === 'number' && gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H) {
        if (v instanceof Tower) return tileEntityRef[gy][gx] === v ? '~t' + gx + ',' + gy : null;
        let cell = grid[gy][gx];
        if (v instanceof Barrack) return cell.item === v ? '~b' + gx + ',' + gy : null;
        if (isSpawnerEntity(v)) return cell.item === v ? '~s' + gx + ',' + gy : null;
        if (!(v instanceof Projectile)) {
            if (cell.item === v) return '~f' + gx + ',' + gy;
            if (droppedItemGrid[gy] && droppedItemGrid[gy][gx] === v) return '~d' + gx + ',' + gy;
            if (tileEntityRef[gy][gx] === v) {
                let type = tileEntityType[gy][gx];
                if (type === TILE_ENTITY_GOLDMINE) return '~g' + gx + ',' + gy;
                if (type === TILE_ENTITY_ASTARMINE) return '~a' + gx + ',' + gy;
            }
        }
    }
    if (v instanceof Projectile) {
        if (!ctx.projIndex) { ctx.projIndex = new Map(); projectiles.forEach((p, i) => ctx.projIndex.set(p, i)); }
        let i = ctx.projIndex.get(v);
        return i === undefined ? null : '~p' + i;
    }
    let pi = players.indexOf(v);
    if (pi >= 0) return '~P' + pi;
    if (!ctx.defs) {
        ctx.defs = new Map();
        for (let key in BASE_UNIT_STATS) { let d = BASE_UNIT_STATS[key]; if (d && typeof d === 'object' && !ctx.defs.has(d)) ctx.defs.set(d, '~Ku' + key); }
        for (let key in BASE_CARD_TYPES) { let d = BASE_CARD_TYPES[key]; if (d && typeof d === 'object' && !ctx.defs.has(d)) ctx.defs.set(d, '~Kb' + key); }
    }
    let d = ctx.defs.get(v);
    return d === undefined ? null : d;
}

const _SNAP_STEPS = 'abcdefghi';

// A unit's path from the step before its current one: [~P, length, skip,
// x0, y0, steps] (steps: one letter per unit move, '(dx,dy)' otherwise).
// Encoded paths are cached per path array (a unit gets a new array when it
// repaths): the steps from the start, and where each step begins in them.
const _snapPathCache = new WeakMap();

function _snapPathSteps(a) {
    let hit = _snapPathCache.get(a);
    if (hit !== undefined) return hit;
    let n = a.length;
    let first = a[0];
    let ok = first !== null && typeof first === 'object' && Object.getPrototypeOf(first) === Object.prototype;
    let px = ok ? first.x : 0, py = ok ? first.y : 0;
    ok = ok && Number.isInteger(px) && Number.isInteger(py) && !(px === 0 && 1 / px < 0) && !(py === 0 && 1 / py < 0);
    let s = '';
    let offsets = null;
    for (let i = 1; ok && i < n; i++) {
        let p = a[i];
        if (p === null || typeof p !== 'object' || Object.getPrototypeOf(p) !== Object.prototype) { ok = false; break; }
        let x = p.x, y = p.y;
        if (!Number.isInteger(x) || !Number.isInteger(y) || (x === 0 && 1 / x < 0) || (y === 0 && 1 / y < 0)) { ok = false; break; }
        let dx = x - px, dy = y - py;
        if (dx >= -1 && dx <= 1 && dy >= -1 && dy <= 1) {
            if (offsets !== null) offsets.push(s.length);
            s += _SNAP_STEPS[(dx + 1) * 3 + dy + 1];
        } else {
            if (offsets === null) { offsets = []; for (let k = 1; k < i; k++) offsets.push(k - 1); }
            offsets.push(s.length);
            s += '(' + dx + ',' + dy + ')';
        }
        px = x; py = y;
    }
    if (ok) {
        // Steps are plain {x, y}; check a few for extra fields.
        for (let k of [0, n - 1, n >> 1]) {
            let c = 0;
            for (let _ in a[k]) c++;
            if (c !== 2) { ok = false; break; }
        }
    }
    hit = ok ? { steps: s, offsets, n, last: a[n - 1], lastX: a[n - 1].x, lastY: a[n - 1].y } : null;
    _snapPathCache.set(a, hit);
    return hit;
}

function _snapEncodePath(o) {
    let a = o.path;
    if (!Array.isArray(a) || a.length === 0) return _snapE(a);
    let n = a.length;
    let skip = Math.max(0, Math.min(n - 1, (o.pathIndex | 0) - 1));
    let enc = _snapPathSteps(a);
    // Paths are not edited in place; should one be, its cache is redone.
    if (enc !== null && (enc.n !== n || enc.last !== a[n - 1] || enc.lastX !== a[n - 1].x || enc.lastY !== a[n - 1].y)) {
        _snapPathCache.delete(a);
        enc = _snapPathSteps(a);
    }
    if (enc === null) return _snapE(a);
    let first = a[skip];
    let from = skip === 0 ? 0 : (enc.offsets === null ? skip : (skip < enc.offsets.length ? enc.offsets[skip] : enc.steps.length));
    return ['~P', n, skip, first.x, first.y, from === 0 ? enc.steps : enc.steps.slice(from)];
}

function _snapDecodePath(enc) {
    let n = enc[1], skip = enc[2];
    let x = enc[3], y = enc[4], s = enc[5];
    let out = new Array(n);
    let head = { x, y };
    // Steps before the current one are never read again.
    for (let i = 0; i <= skip; i++) out[i] = head;
    let k = skip;
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c === 40) { // '('
            let close = s.indexOf(')', i);
            let comma = s.indexOf(',', i);
            x += +s.slice(i + 1, comma);
            y += +s.slice(comma + 1, close);
            i = close;
        } else {
            let d = c - 97;
            x += Math.floor(d / 3) - 1;
            y += (d % 3) - 1;
        }
        out[++k] = { x, y };
    }
    return out;
}

function _snapE(v) {
    switch (typeof v) {
        case 'number':
            if (v === v && v !== Infinity && v !== -Infinity && (v !== 0 || 1 / v > 0)) return v;
            return v !== v ? '~N' : v === Infinity ? '~I' : v === -Infinity ? '~J' : '~Z';
        case 'string':
            return v.charCodeAt(0) === SNAP_TILDE ? '~' + v : v;
        case 'boolean':
            return v;
        case 'object':
            return v === null ? null : _snapEObj(v);
    }
    return '~';
}

function _snapEObj(v) {
    let ctx = _snapEnc;
    let r = ctx.refs.get(v);
    if (r === undefined) {
        r = _snapRootRef(v);
        if (r === null && !Array.isArray(v)) r = _snapStatRefString(v, ctx.statIndex);
        ctx.refs.set(v, r);
    }
    if (r !== null) {
        if (ctx.track !== null) { let c = r.charCodeAt(1); if (c !== 75 && c !== 77) ctx.track.add(v); }
        return r;
    }
    let id = ctx.poolIds.get(v);
    if (id !== undefined) return ctx.poolRefs[id];
    id = ctx.pool.length;
    let ref = '~o' + id;
    ctx.poolIds.set(v, id);
    ctx.poolRefs.push(ref);
    ctx.pool.push(0);
    ctx.pool[id] = _snapEncodePoolValue(v);
    return ref;
}

function _snapEncodePoolValue(v) {
    if (Array.isArray(v)) {
        let out = new Array(v.length + 1);
        out[0] = '~a';
        for (let i = 0; i < v.length; i++) out[i + 1] = _snapE(v[i]);
        return out;
    }
    if (v instanceof Map) {
        let out = [];
        for (let [k, x] of v) out.push(_snapE(k), _snapE(x));
        return ['~m', out];
    }
    if (v instanceof Set) {
        let out = [];
        for (let x of v) out.push(_snapE(x));
        return ['~s', out];
    }
    if (ArrayBuffer.isView(v)) return ['~ta', v.constructor.name, Array.from(v, _snapE)];
    let proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
        // An entity no longer in its list (a dead target, a destroyed
        // building something still points at).
        let name = proto && proto.constructor && proto.constructor.name;
        let fields = {};
        for (let k of Object.keys(v)) {
            if (SNAP_SKIP_KEYS.has(k)) continue;
            fields[k] = (k === 'path' && v instanceof Unit) ? _snapEncodePath(v) : _snapE(v[k]);
        }
        return ['~c', String(name || ''), fields];
    }
    let src = precomputedCloneSource.get(v);
    if (src !== undefined) {
        let srcRef = _snapStatRefString(src, _snapEnc.statIndex);
        if (srcRef !== null && _snapIsStatClone(v, src)) return ['~E', srcRef, _snapE(v.maxEnergy)];
    }
    let out = {};
    for (let k in v) out[k] = _snapE(v[k]);
    return out;
}

// `v` is still `{ ...src, maxEnergy }` (same keys in the same order, the
// same values but maxEnergy).
function _snapIsStatClone(v, src) {
    let n = 0;
    for (let k in v) {
        if (k !== 'maxEnergy' && v[k] !== src[k]) return false;
        n++;
    }
    for (let k in src) n--;
    return n === 0;
}

function _snapEncodeRow(list, e, i, rows, mru) {
    let ctx = _snapEnc;
    let shape = _snapShapeOf(e, mru);
    if (shape.encGen !== ctx.gen) {
        shape.encGen = ctx.gen;
        shape.encTpls = new Map();
        shape.encIndex = ctx.shapes.length;
        ctx.shapes.push(shape.keys);
    }
    let type = _snapTypeKey(list, e);
    let tpl = shape.encTpls.get(type);
    let key = _snapEntityKey(list, e, i);
    if (tpl === undefined) {
        tpl = { index: ctx.tpls.length, obj: e };
        shape.encTpls.set(type, tpl);
        ctx.tpls.push([shape.encIndex, shape.full(e, _snapE, _snapEncodePath)]);
        rows.push([key, tpl.index]);
        return;
    }
    let scratch = ctx.scratch;
    scratch.length = 0;
    shape.diff(e, tpl.obj, _snapE, _snapEncodePath, scratch);
    let row = new Array(2 + scratch.length);
    row[0] = key; row[1] = tpl.index;
    for (let j = 0; j < scratch.length; j++) row[2 + j] = scratch[j];
    rows.push(row);
}

function _snapEncodeGridTypes() {
    let out = [];
    let prev = -1, run = 0;
    for (let gy = 0; gy < GRID_H; gy++) {
        let row = grid[gy];
        for (let gx = 0; gx < GRID_W; gx++) {
            let t = row && row[gx] ? row[gx].type : 0;
            if (t === prev) { run++; continue; }
            if (run > 0) out.push(_snapE(prev), run);
            prev = t; run = 1;
        }
    }
    if (run > 0) out.push(_snapE(prev), run);
    return out;
}

function _snapEncodeCellOwners() {
    let out = [];
    for (let gy = 0; gy < GRID_H; gy++) {
        let row = grid[gy];
        if (!row) continue;
        for (let gx = 0; gx < GRID_W; gx++) {
            let c = row[gx];
            if (c && c.owner !== -1) out.push(gy * GRID_W + gx, _snapE(c.owner));
        }
    }
    return out;
}

// [tile index, type, owner, ...] for every cell of the regions.
function _snapEncodeRegionCells(regions) {
    let out = [], rt = SNAP_REGION_TILES;
    for (let r of regions) {
        let ry = Math.floor(r / 1024), rx = r - ry * 1024;
        for (let gy = ry * rt, gy1 = Math.min(GRID_H, gy + rt); gy < gy1; gy++) {
            let row = grid[gy];
            if (!row) continue;
            for (let gx = rx * rt, gx1 = Math.min(GRID_W, gx + rt); gx < gx1; gx++) out.push(gy * GRID_W + gx, _snapE(row[gx].type), _snapE(row[gx].owner));
        }
    }
    return out;
}

// Always whole (a patch too): globals can diverge after the comparison that
// asked for the patch (an adjacency pass the host did not run, say), and they
// are small. Areas as [id, active, level] where not inactive at level 0.
function _snapEncodeGlobals() {
    return {
        tick: currentTick,
        gameTime,
        nextUnitId: _snapE(nextUnitId),
        gameOver: !!gameOver,
        winner: _snapE(winner),
        cursor: _snapE(pendingPathResolveCursor),
        spawnOrder: _snapE(globalSpawnerReadyOrderCounter),
        rng: (rng && typeof rng.getState === 'function') ? rng.getState() : null,
        pathBudget: pathfindBudgetByPlayer ? Array.from(pathfindBudgetByPlayer, _snapE) : [],
        astarBudget: astarNodeBudgetRemainingByPlayer ? Array.from(astarNodeBudgetRemainingByPlayer, _snapE) : [],
        areaState: _snapEncodeAreaState(),
        resigned: Array.from(resignedTeams || [], _snapE),
        // Which teams play (the order their same-tick commands run in, who
        // can still win): peers joining later must not work it out from the
        // lobby roster.
        teams: Array.from(activeTeamIds || [], _snapE),
        pendingStatRebuilds: Array.from(_pendingResourceStatRebuilds),
        adjacency: [!!_adjacencyNeedsRecalc, !!_adjacencyDirtyAll, _snapE(_adjacencyLastRecalcTick), Array.from(_adjacencyDirtyTiles || [], _snapE), !!_adjacencyPassiveRefreshMode]
    };
}

function _snapEncodeAreaState() {
    let out = [];
    for (let ar of (areas || [])) if (ar && (ar.active || ar.multiplierLevel !== 0)) out.push([_snapE(ar.id), ar.active ? 1 : 0, _snapE(ar.multiplierLevel)]);
    return out;
}

// List order: unit ids as ascending runs [start, length, ...], other lists
// as flat [gx, gy, ...].
function _snapEncodeOrder(list, arr) {
    let out = [];
    if (list === 'u') {
        for (let i = 0; i < arr.length;) {
            let start = arr[i].id, n = 1;
            while (i + n < arr.length && arr[i + n].id === start + n) n++;
            out.push(start, n);
            i += n;
        }
    } else {
        for (let e of arr) out.push(e.gx, e.gy);
    }
    return out;
}

function _snapDecodeOrder(list, enc) {
    let keys = [];
    if (list === 'u') {
        for (let j = 0; j < enc.length; j += 2) for (let k = 0; k < enc[j + 1]; k++) keys.push(enc[j] + k);
    } else {
        for (let j = 0; j < enc.length; j += 2) keys.push(enc[j] + ',' + enc[j + 1]);
    }
    return keys;
}

// The state as a JSON-safe object.
// options.buckets (from snapBucketsFromCodes): a delta with the entities of
// those regions, what they point at, players (with every research lab: they
// share task objects), projectiles and the grid when marked, and the orders
// of lists whose order differs. The globals always come along.
function snapEncodeState(options = null) {
    let only = options && options.buckets ? options.buckets : null;
    _snapEnc = {
        gen: ++_snapEncGen, refs: new Map(), statIndex: _snapStatIndex(), pool: [], poolIds: new Map(), poolRefs: [],
        shapes: [], tpls: [], scratch: [], track: only ? new Set() : null, unitSet: null, unitsSorted: null, projIndex: null, defs: null
    };
    try {
        let out = { v: SNAP_FORMAT, g: _snapEncodeGlobals(), lists: {} };
        let rows = {}, mru = {};
        for (let list of SNAP_LISTS) { rows[list] = []; mru[list] = []; }
        let floor = null;
        let listOf = list => list === 'f' ? (floor || (floor = _snapFloorItems())) : _snapListEntities(list);
        if (!only) {
            for (let list of SNAP_LISTS) {
                let arr = listOf(list);
                for (let i = 0; i < arr.length; i++) if (arr[i]) _snapEncodeRow(list, arr[i], i, rows[list], mru[list]);
            }
            let res = [];
            _snapForReservations(-1, (slot, u) => _snapEncodeReservation(res, slot, u));
            out.res = res;
        } else {
            let done = new Set();
            let at = {};
            for (let list of SNAP_LISTS) at[list] = [];
            let add = (list, e, i) => { if (done.has(e)) return; done.add(e); _snapEncodeRow(list, e, i, rows[list], mru[list]); at[list].push(i); };
            let regions = only.regions;
            let withPlayers = !!only.players;
            let labs = [];
            collectorSpawners.forEach((s, i) => { if (s && s.type === 'research') labs.push(i); });
            if (!withPlayers) for (let i of labs) if (regions.has(_snapRegionOf('s', collectorSpawners[i]))) { withPlayers = true; break; }
            if (withPlayers) {
                for (let i = 0; i < players.length; i++) add('P', players[i], i);
                for (let i of labs) add('s', collectorSpawners[i], i);
            }
            if (only.projectiles) for (let i = 0; i < projectiles.length; i++) add('p', projectiles[i], i);
            if (regions.size > 0) {
                let rt = SNAP_REGION_TILES, ts = TILE * SNAP_REGION_TILES;
                for (let i = 0; i < units.length; i++) {
                    let u = units[i];
                    if (regions.has(Math.floor(u.y / ts) * 1024 + Math.floor(u.x / ts))) add('u', u, i);
                }
                for (let list of SNAP_REGION_LISTS) {
                    if (list === 'u') continue;
                    let arr = listOf(list);
                    for (let i = 0; i < arr.length; i++) {
                        let e = arr[i];
                        if (regions.has(Math.floor(e.gy / rt) * 1024 + Math.floor(e.gx / rt))) add(list, e, i);
                    }
                }
            }
            // Reservations on the carried tiles (their units come along).
            let res = [];
            for (let r of regions) _snapForRegionReservations(r, (slot, u) => _snapEncodeReservation(res, slot, u));
            // Entities pointed at by what is sent come along, so every
            // reference resolves even where the receiver lacks them.
            let where = null;
            for (let pass = 0; pass < 3 && _snapEnc.track.size > 0; pass++) {
                let pending = [];
                for (let e of _snapEnc.track) if (!done.has(e)) pending.push(e);
                _snapEnc.track.clear();
                if (pending.length === 0) break;
                if (!where) {
                    where = new Map();
                    for (let list of SNAP_REGION_LISTS) { let arr = listOf(list); for (let i = 0; i < arr.length; i++) where.set(arr[i], i); }
                }
                for (let e of pending) {
                    let i = where.get(e);
                    if (i === undefined) continue;
                    let r = _snapEnc.refs.get(e);
                    let list = r ? r[1] : null;
                    if (list && SNAP_REGION_LISTS.includes(list)) add(list, e, i);
                }
            }
            // And every other reservation of the units sent: the receiver
            // replaces all of theirs.
            if (rows.u.length > 0) _snapForReservations(-1, (slot, u, r) => { if (!regions.has(r) && done.has(u)) _snapEncodeReservation(res, slot, u); });
            out.res = res;
            out.partial = 1;
            out.regions = Array.from(regions);
            if (withPlayers) out.players = 1;
            if (only.projectiles) out.projectiles = 1;
            out.order = {};
            for (let list of SNAP_ORDER_LISTS) {
                if (only.orders.has(list)) out.order[list] = _snapEncodeOrder(list, listOf(list));
            }
            // Without the order, where each sent building sits in its list: one
            // the receiver lacks goes where the host has it, not at the end.
            // (Units keep id order.)
            out.at = {};
            for (let list of SNAP_ORDER_LISTS) if (list !== 'u' && !out.order[list] && at[list].length > 0) out.at[list] = at[list];
        }
        for (let list of SNAP_LISTS) out.lists[list] = rows[list];
        if (!only || only.grid) {
            out.grid = _snapEncodeGridTypes();
            out.owners = _snapEncodeCellOwners();
        } else if (only.regions.size > 0) {
            // The cells under what the patch carries: a building the receiver
            // lacked needs its cell's owner too.
            out.cells = _snapEncodeRegionCells(only.regions);
        }
        out.shapes = _snapEnc.shapes;
        out.tpls = _snapEnc.tpls;
        out.pool = _snapEnc.pool;
        return out;
    } finally {
        _snapEnc = null;
    }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------
let _snapDec = null;

function _snapD(x) {
    if (typeof x !== 'string') {
        if (x !== null && typeof x === 'object' && x[0] === '~P') return _snapDecodePath(x);
        return x;
    }
    if (x.charCodeAt(0) !== SNAP_TILDE) return x;
    if (x.length === 1) return undefined;
    let c = x.charCodeAt(1);
    if (x.length === 2) {
        if (c === 78) return NaN;        // N
        if (c === 73) return Infinity;   // I
        if (c === 74) return -Infinity;  // J
        if (c === 90) return -0;         // Z
    }
    if (c === SNAP_TILDE) return x.slice(1);
    if (c === 111) return _snapDPool(+x.slice(2)); // o
    if (c === 77) return _snapDStat(x);             // M
    if (c === 75) {                                 // K
        let key = x.slice(3);
        return x.charCodeAt(2) === 117 ? (BASE_UNIT_STATS[key] || null) : (BASE_CARD_TYPES[key] || null);
    }
    let ctx = _snapDec;
    let e = ctx.byRef.get(x);
    if (e !== undefined) return e;
    e = _snapDLookup(x);
    if (e !== null) { ctx.byRef.set(x, e); return e; }
    ctx.missingRefs++;
    return null;
}

// A reference to an entity that the payload does not carry: this peer's own.
// This peer's entity of `list` on tile (gx, gy), found through the tile
// indexes rather than by scanning the list.
function _snapEntityAtTile(list, gx, gy) {
    if (!(gx >= 0 && gy >= 0 && gx < GRID_W && gy < GRID_H)) return undefined;
    let e;
    switch (list) {
        case 't': e = tileEntityRef[gy][gx]; return e instanceof Tower ? e : undefined;
        case 'b': e = grid[gy][gx].item; return e instanceof Barrack ? e : undefined;
        case 's': e = grid[gy][gx].item; return isSpawnerEntity(e) ? e : undefined;
        case 'f': e = grid[gy][gx].item; return (e && !_snapIsBuilding(e)) ? e : undefined;
        case 'g': return tileEntityType[gy][gx] === TILE_ENTITY_GOLDMINE ? (tileEntityRef[gy][gx] || undefined) : undefined;
        case 'a': return tileEntityType[gy][gx] === TILE_ENTITY_ASTARMINE ? (tileEntityRef[gy][gx] || undefined) : undefined;
        case 'd': e = droppedItemGrid[gy] && droppedItemGrid[gy][gx]; return e || undefined;
    }
    return undefined;
}

// A unit of `arr` by id. The list is in id order (ids only grow; removal
// splices), so a binary search finds it; should the order ever differ, a
// miss falls back to a map (built once per decode). No pass over the whole
// list up front: this runs rarely, so such a pass costs ~1 µs per unit.
function _snapFindUnit(arr, id) {
    let lo = 0, hi = arr.length - 1;
    while (lo <= hi) {
        let mid = (lo + hi) >> 1, mv = arr[mid].id;
        if (mv === id) return arr[mid];
        if (mv < id) lo = mid + 1; else hi = mid - 1;
    }
    let ctx = _snapDec;
    let map = ctx.unitFind.get(arr);
    if (map === undefined) {
        map = new Map();
        for (let i = 0; i < arr.length; i++) map.set(arr[i].id, arr[i]);
        ctx.unitFind.set(arr, map);
    }
    return map.get(id);
}

// Whether a carried region holds an entity of `list` that no row names
// (the host does not have it there).
function _snapRegionsHoldOthers(list, regions, byKey) {
    let rt = SNAP_REGION_TILES;
    for (let r of regions) {
        let ry = Math.floor(r / 1024), rx = r - ry * 1024;
        for (let gy = ry * rt; gy < ry * rt + rt && gy < GRID_H; gy++) {
            for (let gx = rx * rt; gx < rx * rt + rt && gx < GRID_W; gx++) {
                let e = _snapEntityAtTile(list, gx, gy);
                if (e !== undefined && e.gx === gx && e.gy === gy && byKey.get(gx + ',' + gy) !== e) return true;
            }
        }
    }
    return false;
}

function _snapAtMatches(arr, made, at) {
    for (let r = 0; r < made.length; r++) if (arr[at[r]] !== made[r]) return false;
    return true;
}

// This peer's current entity for a row key (before a partial restore).
function _snapFindExisting(list, key, arr) {
    if (list === 'u') return _snapFindUnit(arr, key);
    if (list === 'P' || list === 'p') return arr[key];
    let comma = key.indexOf(',');
    let e = _snapEntityAtTile(list, +key.slice(0, comma), +key.slice(comma + 1));
    return e;
}

function _snapDLookup(x) {
    let ctx = _snapDec;
    let list = x[1];
    let key = x.slice(2);
    if (ctx.partial) {
        // Referenced but not carried: an entity this peer keeps as it is.
        if (list === 'u') return (ctx.finals && _snapFindUnit(ctx.finals.u, +key)) || null;
        if (list === 'p' || list === 'P') { let arr = ctx.finals ? ctx.finals[list] : null; return (arr && arr[+key]) || null; }
        return _snapFindExisting(list, key, null) || null;
    }
    let index = ctx.lazyIndex[list];
    if (index === undefined) {
        let arr = ctx.finals ? ctx.finals[list] : null;
        if (!arr) return null;
        index = new Map();
        for (let i = 0; i < arr.length; i++) index.set(String(_snapEntityKey(list, arr[i], i)), arr[i]);
        ctx.lazyIndex[list] = index;
    }
    let e = index.get(key);
    return e === undefined ? null : e;
}

function _snapDStat(x) {
    let ctx = _snapDec;
    let hit = ctx.statMemo.get(x);
    if (hit !== undefined) return hit;
    if (!ctx.statMapReady) _snapEnsureStatMaps();
    let parts = x.slice(2).split(',');
    let p = +parts[0], kind = parts[1] === 'u' ? 'unit' : 'building', lvl = +parts[parts.length - 1];
    let key = parts.length === 4 ? parts[2] : parts.slice(2, parts.length - 1).join(',');
    let entry = PRECOMPUTED_STATS_MAP_PLAYER[p];
    let arr = entry && entry[kind] && entry[kind][key];
    let t = (arr && arr[lvl]) || null;
    if (!t) ctx.missingRefs++;
    ctx.statMemo.set(x, t);
    return t;
}

function _snapDPool(i) {
    let ctx = _snapDec;
    let memo = ctx.poolMemo;
    let hit = memo[i];
    if (hit !== undefined) return hit;
    let enc = ctx.pool[i];
    if (Array.isArray(enc)) {
        let tag = enc[0];
        if (tag === '~a') {
            let out = new Array(enc.length - 1);
            memo[i] = out;
            for (let j = 1; j < enc.length; j++) out[j - 1] = _snapD(enc[j]);
            return out;
        }
        if (tag === '~m') {
            let out = new Map();
            memo[i] = out;
            let a = enc[1];
            for (let j = 0; j < a.length; j += 2) out.set(_snapD(a[j]), _snapD(a[j + 1]));
            return out;
        }
        if (tag === '~s') {
            let out = new Set();
            memo[i] = out;
            for (let y of enc[1]) out.add(_snapD(y));
            return out;
        }
        if (tag === '~ta') {
            let C = globalThis[enc[1]];
            let out = (typeof C === 'function') ? new C(enc[2].length) : new Array(enc[2].length);
            memo[i] = out;
            for (let j = 0; j < enc[2].length; j++) out[j] = _snapD(enc[2][j]);
            return out;
        }
        if (tag === '~E') {
            let src = _snapDStat(enc[1]);
            let out = src ? { ...src, maxEnergy: _snapD(enc[2]) } : {};
            if (src) precomputedCloneSource.set(out, src);
            memo[i] = out;
            return out;
        }
        if (tag === '~c') {
            let C = _snapClassByName(enc[1]);
            let out = C ? Object.create(C.prototype) : {};
            memo[i] = out;
            let fields = enc[2];
            for (let k in fields) out[k] = _snapD(fields[k]);
            return out;
        }
    }
    let out = {};
    memo[i] = out;
    for (let k in enc) out[k] = _snapD(enc[k]);
    return out;
}

// The per-player stat maps follow research and resource penalties: rebuild
// only the players whose inputs changed.
function _snapStatMapSignature(pid) {
    let p = players[pid];
    if (!p) return '';
    try {
        return JSON.stringify([p.researchLevels || null, p.researchMultipliers || null, p.resourceStatMultipliers || null]);
    } catch { return ''; }
}

function _snapEnsureStatMaps() {
    let ctx = _snapDec;
    ctx.statMapReady = true;
    let stale = [];
    for (let pid = 0; pid < players.length; pid++) {
        if (!PRECOMPUTED_STATS_MAP_PLAYER[pid] || ctx.statSignaturesBefore[pid] !== _snapStatMapSignature(pid)) stale.push(pid);
    }
    if (stale.length === 0) return;
    if (PRECOMPUTED_STATS_MAP_PLAYER.length !== players.length || stale.length === players.length) rebuildPrecomputedStatsMapPlayer();
    else for (let pid of stale) rebuildPrecomputedStatsMapPlayer(pid);
    ctx.statMapsRebuilt = stale.length;
}

// Tile index, written directly: the live helpers also release worker
// reservations and mark adjacency dirty, which the snapshot restores itself.
function _snapSetTile(gx, gy, type, ref) {
    if (!(gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H)) return;
    let row = tileEntityRef[gy];
    if (!row) return;
    let prev = row[gx];
    if (prev && prev !== ref) _activeTileEntities.delete(prev);
    tileEntityType[gy][gx] = type || TILE_ENTITY_NONE;
    row[gx] = ref || null;
    if (ref) _activeTileEntities.add(ref);
    _tileEntityVersion++;
}

function _snapTileTypeOf(list, e) {
    switch (list) {
        case 't': return String(e.type || 'tower');
        case 'b': return 'barrack_' + String(e.unitType || 'norm');
        case 's': return String(e.type || 'spawner');
        case 'f': return String(e.type || 'floor_item');
        case 'g': return TILE_ENTITY_GOLDMINE;
        case 'a': return TILE_ENTITY_ASTARMINE;
    }
    return TILE_ENTITY_NONE;
}

// Worker caches that hold entities; the reservation table itself is kept.
function _snapResetWorkerCaches() {
    _workersWithTargetTick = NaN;
    _workerConflictTiles.clear();
    _workerMovingTargetConflicts.clear();
    _workerConflictEntries.clear();
    _workersWithTarget = [];
    _activeBuilderWorkCacheTick = NaN;
    _activeBuilderWorkTargetsByOwner = new Map();
    _activeBuilderPathTiles = new Set();
    _healerDamagedCandidatesTick = NaN;
    _healerDamagedCandidatesByOwner = [];
    _workerSpawnerIndex = null;
}

// Restore an encoded state: whole, or (partial) the regions it carries,
// patching this peer's own objects so references from untouched entities
// stay valid. Returns { unitsById, missingRefs, statMapsRebuilt, changed }.
function snapDecodeState(S, options = null) {
    if (!S || S.v !== SNAP_FORMAT) return null;
    let collect = !!(options && options.collectChanges);
    let partial = !!S.partial;
    let pool = S.pool || [];
    let statSignaturesBefore = players.map((_, pid) => _snapStatMapSignature(pid));
    _snapDec = {
        byRef: new Map(), pool, poolMemo: new Array(pool.length), statMemo: new Map(), statMapReady: false,
        statSignaturesBefore, missingRefs: 0, statMapsRebuilt: 0, lazyIndex: {}, finals: null,
        partial: !!S.partial, unitFind: new Map()
    };
    let ctx = _snapDec;
    let changed = collect ? [] : null;
    try {
        let shapes = (S.shapes || []).map(k => _snapGetShape(k));
        let tpls = S.tpls || [];
        let typeOfTpl = tpls.map(t => {
            let shape = shapes[t[0]];
            let col = shape.colIndex.get('unitType');
            if (col === undefined) col = shape.colIndex.get('type');
            return col === undefined ? '' : _snapD(t[1][col]);
        });
        // The row's type as _snapTypeKey reads it (templates are per type).
        let rowType = (list, row) => {
            if (list !== 'u' && list !== 'b' && list !== 't' && list !== 's' && list !== 'f') return '';
            let shape = shapes[tpls[row[1]][0]];
            let col = (list === 'u' || list === 'b') ? shape.colIndex.get('unitType') : shape.colIndex.get('type');
            if (col !== undefined) for (let j = 2; j < row.length; j += 2) if (row[j] === col) return _snapD(row[j + 1]);
            return typeOfTpl[row[1]];
        };

        // 1. Objects. A partial restore keeps this peer's object when kind
        // and layout match; everything else is created.
        let regions = partial ? new Set(S.regions || []) : null;
        let prev = {}, shells = {}, finals = {}, removed = {};
        // The floor list is gathered from the grid: only when needed.
        let floorList = null;
        let listOf = list => list === 'f' ? (floorList || (floorList = _snapFloorItems())) : _snapListEntities(list);
        for (let list of SNAP_LISTS) {
            let rows = S.lists[list] || [];
            let whole = !partial || (list === 'P' && S.players) || (list === 'p' && S.projectiles);
            let orderEnc = partial && S.order ? S.order[list] : null;
            let atEnc = partial && S.at && Array.isArray(S.at[list]) && S.at[list].length === rows.length ? S.at[list] : null;
            let arr = (list === 'f' && partial && rows.length === 0 && !orderEnc && regions.size === 0) ? null : listOf(list);
            prev[list] = arr;
            let made = new Array(rows.length);
            let byKey = new Map();
            let fresh = 0, freshUnits = null;
            for (let r = 0; r < rows.length; r++) {
                let row = rows[r];
                let key = row[0];
                let type = rowType(list, row);
                let old = partial ? _snapFindExisting(list, key, arr) : undefined;
                let e;
                if (old !== undefined && (list === 'P' || list === 'p' || _snapTypeKey(list, old) === type)) {
                    e = old;
                    if (list === 'u') removeUnitSpatial(e);
                    let keys = shapes[tpls[row[1]][0]].keys;
                    let own = Object.keys(old);
                    if (!_snapKeysEqual(own, keys)) { let want = new Set(keys); for (let k of own) if (!want.has(k)) delete old[k]; }
                } else {
                    e = _snapNewShell(list, type);
                    fresh++;
                    if (list === 'u') (freshUnits ||= []).push(e);
                }
                made[r] = e;
                byKey.set(key, e);
                ctx.byRef.set('~' + list + key, e);
            }
            shells[list] = made;
            let result;
            if (whole) {
                result = made;
            } else if (list === 'P' || list === 'p') {
                result = arr;
            } else if (orderEnc) {
                result = [];
                for (let k of _snapDecodeOrder(list, orderEnc)) {
                    let e = byKey.get(k);
                    if (e === undefined) e = _snapFindExisting(list, k, arr);
                    if (e !== undefined) result.push(e);
                }
            } else if (list === 'u') {
                // Without the order (membership agreed when compared), units
                // the host has and this peer lacks join in id order; the
                // others stay (a difference in membership since then shows
                // in the next comparison, which then carries the order).
                result = arr;
                removed[list] = [];
                if (freshUnits !== null) {
                    result = arr.slice();
                    for (let u of freshUnits) {
                        let lo = 0, hi = result.length;
                        while (lo < hi) { let mid = (lo + hi) >> 1; if (result[mid].id < u.id) lo = mid + 1; else hi = mid; }
                        result.splice(lo, 0, u);
                    }
                }
            } else if (fresh === 0 && (!atEnc || _snapAtMatches(arr, made, atEnc)) && !_snapRegionsHoldOthers(list, regions, byKey)) {
                // Every row updated an entity in place (where the host has
                // it) and the carried regions hold nothing else: membership
                // and order stay.
                result = arr;
            } else if (rows.length > 0 || (list !== 'u' && regions.size > 0)) {
                // Same membership outside the carried regions; inside them,
                // what the rows list (buildings, mines and drops never move,
                // so only units may sit in a region on one peer only).
                result = [];
                let others = atEnc ? [] : result;
                for (let e of arr) {
                    let k = _snapEntityKey(list, e, 0);
                    let nb = byKey.get(k);
                    if (nb !== undefined) { if (!atEnc) { result.push(nb); byKey.delete(k); } continue; }
                    if (list !== 'u' && regions.has(_snapRegionOf(list, e))) continue;
                    others.push(e);
                }
                if (atEnc) {
                    // The rows at the host's indexes, the rest in order around them.
                    let placed = made.map((e, r) => r).sort((a, b) => (atEnc[a] - atEnc[b]) || (a - b));
                    let oi = 0;
                    for (let r of placed) {
                        while (result.length < atEnc[r] && oi < others.length) result.push(others[oi++]);
                        result.push(made[r]);
                    }
                    while (oi < others.length) result.push(others[oi++]);
                } else {
                    for (let e of byKey.values()) result.push(e);
                }
            } else {
                result = arr;
            }
            if (removed[list] !== undefined) {
                // (set above)
            } else if (!partial || result === arr) {
                removed[list] = [];
            } else {
                let inResult = new Set(result);
                removed[list] = arr.filter(e => !inResult.has(e));
            }
            finals[list] = result;
        }
        ctx.finals = finals;

        // 2. Fields. Players first: the stat maps follow their research.
        let tplValues = new Array(tpls.length);
        let valuesOf = (row) => {
            let tv = tplValues[row[1]];
            if (tv === undefined) {
                let enc = tpls[row[1]][1];
                tv = new Array(enc.length);
                for (let j = 0; j < enc.length; j++) tv[j] = _snapD(enc[j]);
                tplValues[row[1]] = tv;
            }
            if (row.length === 2) return tv;
            let v = tv.slice();
            for (let j = 2; j < row.length; j += 2) v[row[j]] = _snapD(row[j + 1]);
            return v;
        };
        let fill = (list) => {
            let rows = S.lists[list] || [];
            let made = shells[list];
            for (let r = 0; r < rows.length; r++) {
                let row = rows[r];
                let shape = shapes[tpls[row[1]][0]];
                let e = made[r];
                let v = valuesOf(row);
                if (collect && partial) {
                    let fields = [];
                    for (let c = 0; c < shape.cols.length; c++) {
                        let a = e[shape.cols[c]], b = v[c];
                        if (a === b || (a !== a && b !== b)) continue;
                        // Objects: a different entity, or different contents
                        // (paths from the current step on: earlier steps are
                        // not sent).
                        if (shape.cols[c] === 'path' && Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
                            let from = Math.max(0, (v[shape.colIndex.get('pathIndex')] | 0) - 1), same = true;
                            for (let i = from; same && i < a.length; i++) same = !!a[i] && !!b[i] && a[i].x === b[i].x && a[i].y === b[i].y;
                            if (same) continue;
                        }
                        if (a && b && typeof a === 'object' && typeof b === 'object' && _snapSameValue(a, b, 3)) continue;
                        fields.push(shape.cols[c]);
                    }
                    if (fields.length > 0) changed.push(list + row[0] + ':' + fields.slice(0, 10).join(','));
                }
                shape.assign(e, v);
            }
        };
        fill('P');
        players = finals.P;
        _snapEnsureStatMaps();
        for (let list of SNAP_LISTS) if (list !== 'P') fill(list);

        // 3. Lists and globals.
        units = finals.u;
        towers = finals.t;
        barracks = finals.b;
        collectorSpawners = finals.s;
        if (finals.g !== goldMines) { let a = finals.g.slice(); goldMines.length = 0; for (let m of a) goldMines.push(m); }
        if (finals.a !== astarMines) { let a = finals.a.slice(); astarMines.length = 0; for (let m of a) astarMines.push(m); }
        projectiles = finals.p;

        let g = S.g || {};
        currentTick = Math.max(0, Math.floor(Number(g.tick) || 0));
        gameTime = Math.max(0, Math.floor(Number(g.gameTime) || 0));
        nextUnitId = _snapD(g.nextUnitId);
        gameOver = !!g.gameOver;
        winner = _snapD(g.winner);
        pendingPathResolveCursor = _snapD(g.cursor);
        globalSpawnerReadyOrderCounter = _snapD(g.spawnOrder);
        if (rng && typeof rng.setState === 'function' && g.rng !== null && g.rng !== undefined) rng.setState(g.rng);
        if (Array.isArray(g.pathBudget)) for (let i = 0; i < g.pathBudget.length; i++) pathfindBudgetByPlayer[i] = _snapD(g.pathBudget[i]);
        if (Array.isArray(g.astarBudget)) for (let i = 0; i < g.astarBudget.length; i++) astarNodeBudgetRemainingByPlayer[i] = _snapD(g.astarBudget[i]);
        resignedTeams = new Set((g.resigned || []).map(_snapD));
        if (Array.isArray(g.teams) && g.teams.length > 0) activeTeamIds = g.teams.map(_snapD);
        if (Array.isArray(g.pendingStatRebuilds)) {
            _pendingResourceStatRebuilds.clear();
            for (let k of g.pendingStatRebuilds) _pendingResourceStatRebuilds.add(k);
        }
        if (Array.isArray(g.areaState)) {
            let was = new Map();
            for (let ar of (areas || [])) if (ar) { was.set(ar, ar.active + ':' + ar.multiplierLevel); ar.active = false; ar.multiplierLevel = 0; }
            for (let entry of g.areaState) {
                if (!Array.isArray(entry)) continue;
                let ar = getAreaById(_snapD(entry[0]));
                if (!ar) continue;
                ar.active = !!entry[1];
                ar.multiplierLevel = _snapD(entry[2]);
            }
            for (let [ar, v] of was) if (v !== ar.active + ':' + ar.multiplierLevel) { dirtyAreas = true; if (typeof _markCombinedBgAreaDirty === 'function') _markCombinedBgAreaDirty(ar.id, 1); }
        }

        // 4. Grid cells, tiles and indexes.
        if (Array.isArray(S.grid)) {
            let idx = 0;
            for (let j = 0; j < S.grid.length; j += 2) {
                let t = _snapD(S.grid[j]), n = S.grid[j + 1];
                for (let k = 0; k < n; k++, idx++) {
                    let row = grid[Math.floor(idx / GRID_W)];
                    if (row) row[idx % GRID_W].type = t;
                }
            }
        }
        if (Array.isArray(S.cells)) {
            for (let j = 0; j + 2 < S.cells.length; j += 3) {
                let idx = S.cells[j];
                let row = Number.isInteger(idx) && idx >= 0 ? grid[Math.floor(idx / GRID_W)] : null;
                if (!row) continue;
                let c = row[idx % GRID_W];
                c.type = _snapD(S.cells[j + 1]);
                c.owner = _snapD(S.cells[j + 2]);
            }
            // Indexes built from cell owners (hostile structures) rebuild.
            _tileEntityVersion++;
        }
        if (Array.isArray(S.owners)) {
            for (let gy = 0; gy < GRID_H; gy++) { let row = grid[gy]; if (row) for (let gx = 0; gx < GRID_W; gx++) row[gx].owner = -1; }
            for (let j = 0; j < S.owners.length; j += 2) {
                let idx = S.owners[j];
                let row = grid[Math.floor(idx / GRID_W)];
                if (row) row[idx % GRID_W].owner = _snapD(S.owners[j + 1]);
            }
        }
        const tileLists = ['t', 'b', 's', 'f', 'g', 'a'];
        if (!partial) {
            for (let gy = 0; gy < GRID_H; gy++) { let row = grid[gy]; if (row) for (let gx = 0; gx < GRID_W; gx++) { row[gx].item = null; row[gx].droppedItem = null; } }
            initTileEntityLookup();
            for (let list of tileLists) {
                for (let e of finals[list]) {
                    if (list === 'b' || list === 's' || list === 'f') { let row = grid[e.gy]; if (row && row[e.gx]) row[e.gx].item = e; }
                    _snapSetTile(e.gx, e.gy, _snapTileTypeOf(list, e), e);
                }
            }
        } else {
            for (let list of tileLists) {
                for (let e of removed[list]) {
                    if (getTileEntityRef(e.gx, e.gy) === e) _snapSetTile(e.gx, e.gy, TILE_ENTITY_NONE, null);
                    let row = grid[e.gy];
                    if (row && row[e.gx] && row[e.gx].item === e) row[e.gx].item = null;
                }
            }
            for (let list of tileLists) {
                for (let e of shells[list]) {
                    if (list === 'b' || list === 's' || list === 'f') { let row = grid[e.gy]; if (row && row[e.gx]) row[e.gx].item = e; }
                    _snapSetTile(e.gx, e.gy, _snapTileTypeOf(list, e), e);
                }
            }
        }
        // Dropped items: list and indexes rebuilt when they changed.
        if (!partial || finals.d !== prev.d || shells.d.length > 0) {
            for (let e of prev.d) { let row = grid[e.gy]; if (row && row[e.gx]) row[e.gx].droppedItem = null; }
            droppedItems = [];
            initDroppedItemGrid();
            for (let d of finals.d) {
                _setDroppedItemAt(d.gx, d.gy, d);
                _addDroppedItemToAreaBucket(d, getAreaIdAtTile(d.gx, d.gy));
                d._droppedIndex = droppedItems.length;
                droppedItems.push(d);
            }
        }
        // Worker reservations.
        if (!partial) {
            resetSimulationTickCaches();
            _snapDecodeReservations(S.res);
        } else {
            _snapResetWorkerCaches();
            _snapDecodeReservations(S.res, { regions, carried: shells.u, removed: removed.u });
        }
        if (Array.isArray(g.adjacency)) {
            _adjacencyNeedsRecalc = !!g.adjacency[0];
            _adjacencyDirtyAll = !!g.adjacency[1];
            _adjacencyLastRecalcTick = _snapD(g.adjacency[2]);
            _adjacencyDirtyTiles = new Set((g.adjacency[3] || []).map(_snapD));
            _adjacencyPassiveRefreshMode = !!g.adjacency[4];
        }

        if (partial) {
            for (let u of removed.u) removeUnitSpatial(u);
            for (let u of shells.u) { u.prevX = u.x; u.prevY = u.y; updateUnitSpatial(u); }
        } else {
            initSpatialHash();
            for (let u of units) { u.prevX = u.x; u.prevY = u.y; updateUnitSpatial(u); }
        }
        for (let p of shells.p) { p.prevX = p.x; p.prevY = p.y; }
        if (!partial || shells.t.length > 0 || removed.t.length > 0) recalculateLaserConnections();

        let unitsById = null;
        return {
            get unitsById() { if (!unitsById) { unitsById = new Map(); for (let u of units) unitsById.set(u.id, u); } return unitsById; },
            missingRefs: ctx.missingRefs, statMapsRebuilt: ctx.statMapsRebuilt, changed, restored: shells, removed
        };
    } finally {
        _snapDec = null;
    }
}

// For reporting what a patch changed: entities by identity, plain values by
// content (a few levels deep).
function _snapSameValue(a, b, depth) {
    if (a === b) return true;
    if (a !== a && b !== b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    let pa = Object.getPrototypeOf(a), pb = Object.getPrototypeOf(b);
    if (pa !== pb) return false;
    if (pa !== Object.prototype && pa !== Array.prototype) return false; // entities: identity only
    if (depth <= 0) return true;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!_snapSameValue(a[i], b[i], depth - 1)) return false;
        return true;
    }
    let ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (let k of ka) if (!_snapSameValue(a[k], b[k], depth - 1)) return false;
    return true;
}

// Caches whose hits change outcomes (a cached path skips the path budget, a
// cached enemy target holds until invalid). A peer that restores a snapshot
// starts without them, so at a resync every peer drops them on the same tick.
function snapFlushHistoryCaches() {
    _bumpPathTopologyVersion();
    closestEnemyChunkQueryCache.clear();
    // Worker caches stamped with gameTime: the previous tick's last part and
    // the next tick's first part share it, so a peer that restores would
    // otherwise rebuild them while the others still use theirs.
    _snapResetWorkerCaches();
}
