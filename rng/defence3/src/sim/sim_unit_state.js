"use strict";
// Authoritative numeric unit state. Float32 stores gameplay quantities;
// kernels (JS and Rust) compute in doubles and round at each store, as the
// objects' accessors do. Objects retain cold/reference fields and expose
// these columns through prototype accessors.
// Slots are local addresses, never IDs or part of snapshots/lockstep hashes.
// Status effects: counted down (and their damage dealt) for every unit at
// once by SIM_KERNEL_STATUS (see statusPrepassRun in unit.js).
const SIM_UNIT_STATUS_COLUMNS = ['teleportHideTicks', 'burning', 'burnTickDamage', 'poisoned', 'poisonTickDamage',
    'frozen', 'iceTickDamage', 'wet', 'sandy', 'watched', 'workerTransferCooldown'];
// The timers among them that SIM_KERNEL_STATUS runs only for units flagged
// stOn (the damage values matter only while their timer runs).
const SIM_STATUS_TIMER_COLUMNS = ['teleportHideTicks', 'burning', 'poisoned', 'frozen', 'wet', 'sandy', 'watched'];
// Stacks and levels (the effective-stats kernel, SIM_KERNEL_EFF_UNITS):
// NaN stands for a field not set (its accessor reads undefined).
const SIM_UNIT_LEVEL_COLUMNS = ['stackCount', 'unitLevel', 'baseLevel', 'effectiveStacks', 'effectiveLevel', '_lastAppliedEffectiveLevel'];
const SIM_UNIT_COLUMNS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy',
    'energy', 'r', 'collisionR', 'pathIndex', 'commandState', 'attackTimer', 'attackFlash', ...SIM_UNIT_STATUS_COLUMNS, ...SIM_UNIT_LEVEL_COLUMNS];
// Columns holding whole numbers only (ids, owners, commands, tick counts):
// 32-bit integers (the rest Float32: fractions, and NaN for "not set" in the
// level columns; tests/storage-abi.test.cjs checks the Rust twins' types).
const SIM_UNIT_INT_COLUMNS = new Set(['id', 'owner', 'commandState', 'attackFlash', 'teleportHideTicks', 'burning', 'poisoned', 'frozen', 'wet', 'sandy', 'watched', 'workerTransferCooldown']);
// (Narrower where the values fit, read every tick by most kernels: owners
// Int8 (players, -1 none), commands and the attack flash timer Uint8.)
const SIM_UNIT_NARROW_COLUMNS = { owner: Int8Array, commandState: Uint8Array, attackFlash: Uint8Array };
// Positions (x, y, prevX, prevY; and x0, y0 below): Int32 in eighths of a
// pixel (UNIT_POSITION_QUANTIZATION: every position is a whole eighth), so
// the kernels move units with integer vector arithmetic and find tiles by a
// shift. The accessors read and write pixels (a store rounds to the nearest
// eighth, halves up: _quantizeUnitWorldCoord). Range: +-2^28 px.
const SIM_POS_SCALE = 8, SIM_POS_INV = 0.125;
const SIM_UNIT_POS_COLUMNS = new Set(['x', 'y', 'prevX', 'prevY']);
function simPosQ(v) { return Math.round(v * SIM_POS_SCALE); }
function _simUnitColumnType(k) { return SIM_UNIT_NARROW_COLUMNS[k] || (k === 'pathIndex' || SIM_UNIT_INT_COLUMNS.has(k) || SIM_UNIT_POS_COLUMNS.has(k) ? Int32Array : Float32Array); }
// Read and written through prototype accessors: the columns are the state
// (the movement kernel moves units without touching their objects).
const SIM_UNIT_ACCESSOR_COLUMNS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy', 'energy', 'pathIndex', 'commandState', 'attackTimer', 'attackFlash', ...SIM_UNIT_STATUS_COLUMNS, ...SIM_UNIT_LEVEL_COLUMNS];
// Radii: plain fields on the unit, copied into the columns by
// simUnitMirror (the spatial index calls it; they rarely change).
const SIM_UNIT_MIRROR_COLUMNS = ['r', 'collisionR'];
// Accessor keys that are not columns (see simUnitStateKeys): the path is a
// plain reference behind a setter that disarms the movement kernel.
// The state hash's object fields (not numbers of their own column): per-slot
// JavaScript arrays beside the columns (columns.oc_<field>, behind the
// unit's accessors; a detached unit's in its _det), each set summed into
// the slot's digest (hObj: see _simHTerm), so the hash kernel reads one
// column for all of them.
const SIM_UNIT_OBJ_FIELDS = ['holdPosition', 'forcedAttackTarget', 'targetUnit', 'targetPos', '_attackMoveGx', '_attackMoveGy',
    'workerTarget', 'workerTargetType', 'carryingValue', '_workerReservedTileIndex', 'builderHasMaterial', 'healerHasMaterial', 'researcherHasMaterial',
    '_astarBudgetRetryTick', '_scoutTarget', '_routeKey', 'workerType'];
// (Statements a field's setter runs too, with c the columns, s the slot, v
// the value: columns kept from it.)
const SIM_UNIT_OBJ_HOOKS = { workerType: 'c.isWk[s] = v ? 1 : 0;' };
const SIM_UNIT_EXTRA_ACCESSORS = ['path', 'targetBuilding', 'pathIsFallbackAstar', '_pendingPathTarget', 'workerState', '_workerNextIdleRetargetTick', 'dead', '_navLastD', '_floorTile', '_sepMoved', '_statsBehind', '_forcedTargetLastSeenX', '_forcedTargetLastSeenY',
    '_builderLastWatchX', '_builderLastWatchY', '_builderLastMoveTick', '_routeEnd', 'watchedByTeam', ...SIM_UNIT_OBJ_FIELDS,
    // (Its effective tables, as it has them: computed at its last stats
    // change, from the tables of then, so not derivable from the state; one
    // pool entry per distinct object, stat map entries by reference.)
    'preComputedEffective', 'preComputed'];
// Every field in the digest: the object fields and the accessors' plain
// values (structure target, pending way, worker state and its search). Not
// the unit type (set once, read everywhere: a plain field; a wrong type
// shows in its stats at once) nor the path (set on every re-route; where it
// leads shows in the position, velocity and pathIndex columns).
const SIM_HASH_DIGEST_FIELDS = [...SIM_UNIT_OBJ_FIELDS, 'targetBuilding', '_pendingPathTarget', 'pathIsFallbackAstar', 'workerState', '_workerNextIdleRetargetTick'];

// ---- The digest ----
// A field's term: (its key ^ the value's word) * M, summed mod 2^32 (the
// hash kernel, wasm/src/k.rs k_snap_units, mixes its columns the same way).
// Words: a unit its id; a structure or tile target (gx, gy) its tile; a
// point its Float32 bits; whole numbers themselves, others their bits;
// strings a code. Only what never changes in place is read, so a restore
// (setting every field anew) gets the same digest.
const SIM_H_M = Math.imul(16777619, 2654435761);
const SIM_H_UNDEF = -2147483648, SIM_H_NULL = -2147483647, SIM_H_NAN = -2147483646, SIM_H_OBJ = -2147483645;
const _simHF64 = new Float64Array(1), _simHI32 = new Int32Array(_simHF64.buffer), _simHF32 = new Float32Array(2), _simHU32 = new Int32Array(_simHF32.buffer);
const _simHStrCodes = new Map();
function _simHStr(s) {
    let c = _simHStrCodes.get(s);
    if (c !== undefined) return c;
    c = 2166136261 | 0;
    for (let i = 0; i < s.length; i++) c = Math.imul(c ^ s.charCodeAt(i), 16777619);
    c = Math.imul(c ^ 0x9e37, 16777619);
    if (_simHStrCodes.size > 4096) _simHStrCodes.clear();
    _simHStrCodes.set(s, c);
    return c;
}
function _simHKey(name) { return Math.imul(_simHStr(name) ^ 0x2c1b3c6d, 2246822519); }
function _simHEnc(v) {
    switch (typeof v) {
        case 'number':
            if ((v | 0) === v && !(v === 0 && 1 / v < 0)) return v < -2147483640 ? Math.imul(v, 31) : v;
            if (v !== v) return SIM_H_NAN;
            _simHF64[0] = v;
            return Math.imul(_simHI32[0] ^ 0x5bd1e995, 16777619) ^ _simHI32[1];
        case 'undefined': return SIM_H_UNDEF;
        case 'boolean': return v ? 0x3bd : 0x2bd;
        case 'string': return _simHStr(v);
        case 'object':
            if (v === null) return SIM_H_NULL;
            if (v instanceof Unit) return v.id | 0;
            if (typeof v.gx === 'number') return -16 - ((v.gy | 0) * 65536 + (v.gx | 0));
            if (typeof v.x === 'number') { _simHF32[0] = v.x; _simHF32[1] = v.y; return Math.imul(_simHU32[0] ^ 0x27d4eb2d, 16777619) ^ _simHU32[1]; }
            return SIM_H_OBJ;
    }
    return SIM_H_OBJ;
}
// A field's term for value v (key: _simHKey(field)).
function _simHTerm(key, v) { return Math.imul(key ^ _simHEnc(v), SIM_H_M); }
// The digest at a slot's start: its fields unset (the structure target null,
// see _simUnitSlotStart).
let _simH0 = null;
function _simHDigest0() {
    if (_simH0 === null) { let h = 0; for (const k of SIM_HASH_DIGEST_FIELDS) h = (h + _simHTerm(_simHKey(k), k === 'targetBuilding' ? null : undefined)) | 0; _simH0 = h; }
    return _simH0;
}
// The digest from a unit's values (checks and tests: it equals the column).
function simUnitHashDigest(u) {
    let h = 0;
    for (const k of SIM_HASH_DIGEST_FIELDS) h = (h + _simHTerm(_simHKey(k), u[k])) | 0;
    return h;
}

// Randomness without a sequence: a number in [0, 1) from what varies (the
// tick, an entity's id or position, a salt), the same on every peer in any
// order of evaluation (any thread). (The shared rng() is for map making.)
function simHashRand(a, b, c = 0) {
    let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Unit types by first sight (peer-local indices: only ever mapped back to
// the type's name).
const _simUnitTypeNames = [], _simUnitTypeIdx = new Map();
function simUnitTypeIndex(type) {
    let i = _simUnitTypeIdx.get(type);
    if (i === undefined) { i = _simUnitTypeNames.length; if (i >= 32767) return -1; _simUnitTypeNames.push(type); _simUnitTypeIdx.set(type, i); }
    return i;
}
// (Unit.maxEnergy into its column: called where unit stats are applied, the
// same on every peer.)
function simUnitMaxE(u) {
    const c = u && u._us;
    if (c) c.maxE[u._si] = Number(u.maxEnergy);
}
function simUnitMirror(u) {
    const c = u._us;
    if (!c) return;
    const s = u._si;
    c.r[s] = u.r; c.collisionR[s] = u.collisionR;
}

// Per-slot state of the movement kernel (see sim_move.js), in the columns
// object too (unit accessors disarm through it). [name, type, per slot].
const SIM_MOVE_WINDOW = 16;
// Words of a slot's flow look-ahead record (unit.mvNav).
const SIM_NAV_STRIDE = 8;
const SIM_MOVE_COLUMNS = [['mvOn', Uint8Array, 1], ['mvOut', Uint8Array, 1], ['mvFlags', Uint8Array, 1],
    ['mvSpd', Float32Array, 1], ['mvLane', Float32Array, 1], ['mvCost', Float32Array, 1],
    ['mvSpent', Uint8Array, 1], ['mvReach', Uint8Array, 1], ['mvBase', Int32Array, 1], ['mvWlen', Uint8Array, 1],
    ['mvPlen', Int32Array, 1], ['mvScan', Int32Array, 1], ['mvFloor', Int32Array, 1], ['mvPath', Int32Array, 1],
    // Parked idle workers (mvOn 2): the tick their Unit.update next does anything.
    ['mvWake', Int32Array, 1],
    // Flow mode (mvFlags 64): the flow slot and its generation, and the
    // destination tile. Stats kept current for orders that arm units
    // without reading them (see simMoveStatsChanged).
    ['mvFlow', Int32Array, 1], ['mvFGen', Int32Array, 1], ['mvDest', Int32Array, 1],
    ['mvReachD', Uint8Array, 1], ['mvReachA', Uint8Array, 1], ['mvShoot', Uint8Array, 1],
    // Whole area steps of its attack range (floor), for the kernel's
    // drive-by look.
    ['mvRangeK', Uint8Array, 1],
    // Flow mode's look-ahead (mvNav) from tile T (-1 none), made with the
    // navigation build V, wall version W and destination field kind G: the
    // next tile, the one after, the farthest one it heads straight for, and
    // whether that is over open ground.
    // A long-range hold (mvReach above 1): held while the unit's window (tile
    // * 9 + zone, mvHWin) and its target's tile (mvHTT) are those it was
    // found in range by areas at, under area layout mvHVer.
    ['mvHWin', Int32Array, 1], ['mvHTT', Int32Array, 1], ['mvHVer', Int32Array, 1],
    // (One record a slot, SIM_NAV_STRIDE words: T, D, V, W, G, N1, N2,
    // Far << 1 | Open; a steer touches one cache line. See simFlowLook.)
    ['mvNav', Int32Array, SIM_NAV_STRIDE],
    // The combat scan (SIM_KERNEL_COMBAT_SCAN): its aggro range (pixels),
    // and at tick cbTick the nearest visible enemy's slot (-1 none).
    ['cbRange', Float32Array, 1], ['cbT', Int32Array, 1], ['cbTick', Int32Array, 1],
    // (The acquisition tier's result as committed: its target's id and the
    // range it was looked for with; see unit.js _acqTierStep.)
    ['cbTId', Int32Array, 1], ['cbRangeS', Float32Array, 1],
    // (And the structure it found: its tile, -1 none.)
    ['cbS', Int32Array, 1],
    // The drive-by look's answer (SIM_KERNEL_DRIVEBY) at tick dbTick: a unit
    // (dbT its slot, dbTI its id), -1 none (then dbS a structure's tile, -1
    // none), -2 not worked out there (Unit.update looks).
    ['dbT', Int32Array, 1], ['dbTI', Int32Array, 1], ['dbS', Int32Array, 1], ['dbTick', Int32Array, 1],
    // A moving unit with an idle or waiting unit of its owner in its tile or
    // one beside it at the tick's start (cwNear 1) as of tick cwTick (the
    // combat scan): waiting in a crowd (see NAV_CROWD_TILES).
    ['cwNear', Uint8Array, 1], ['cwTick', Int32Array, 1],
    // (And the units listed in its 3x3 tiles, capped: a waiting unit goes
    // on once that thins out.)
    ['cwDense', Uint16Array, 1],
    // Flow mode: the tick its route may start (see navFieldReadyTick).
    ['mvReady', Int32Array, 1],
    // Attack hold (mvOn 3; see simMoveTryHold): the target's slot and id,
    // the target's tile, and the unit's own tile and window zone, as when
    // the hold began.
    ['mvHT', Int32Array, 1], ['mvHTId', Int32Array, 1],
    // Chase (mvOn 4; see simMoveTryChase): the target in mvHT/mvHTId, the
    // range in mvReach, and the look-ahead of its direct step (_isChaseStepOpen).
    ['mvChs', Float32Array, 1],
    // A parked unit waiting for its way (mvFlags 8: simMoveTryParkRoute): the
    // target it was sent to and how near counts as there.
    ['mvTgX', Float32Array, 1], ['mvTgY', Float32Array, 1], ['mvTgTol', Float32Array, 1],
    // A flow unit's steady window (SIM_KERNEL_MOVE_STEP's steady step): its
    // committed step is taken as it is until this tick (0: not steady).
    ['mvSteady', Int32Array, 1],
    // Effective stats (SIM_KERNEL_EFF_UNITS): 1 when the unit's base tables
    // fit its baseLevel and its window is known (esRad chunks around it,
    // esType its spatial type); esTaken the pass that took it; esFlag the
    // kernel's verdict per strided entry.
    ['esOk', Uint8Array, 1], ['esRad', Int32Array, 1], ['esType', Int32Array, 1], ['esTaken', Int32Array, 1],
    // A parked idle worker's work version check (mvFlags 2; see
    // simMoveTryPark): its work type, reach (tiles), origin tile, whether its
    // own tile counts too (wkTwice 1; 0: the origin is the worker itself; 2:
    // a healer), the version its last search failed at and that backoff's
    // end, and the tick of its next wake for anything else.
    ['wkType', Int32Array, 1], ['wkD', Int32Array, 1], ['wkOx', Int32Array, 1], ['wkOy', Int32Array, 1], ['wkTwice', Uint8Array, 1],
    ['wkFail', Int32Array, 1], ['wkUntil', Int32Array, 1], ['wkSched', Int32Array, 1],
    // A parked builder's last watchdog sample (mvFlags 4): woken at a sample
    // tick only when it no longer stands there.
    // A builder's watchdog (worker.js): its last sampled position and the
    // tick it last moved (Unit._builderLastWatchX/Y, _builderLastMoveTick;
    // NaN / INT_MIN unset), sampled by the kernel for a parked builder.
    ['wkWx', Float32Array, 1], ['wkWy', Float32Array, 1], ['wkLmt', Int32Array, 1],
    // The status pre-pass's events (1 damaged, 2 its watch ended, 4 died)
    // and the damage dealt.
    ['stEv', Uint8Array, 1], ['stDot', Float32Array, 1],
    // Damage over time dealt since its last report (SIM_KERNEL_STATUS).
    ['stAcc', Float32Array, 1],
    // 1 while one of its status timers (SIM_STATUS_TIMER_COLUMNS) may run:
    // set by their accessors (and at a slot's start, a restore), cleared by
    // SIM_KERNEL_STATUS when all are out; the kernel looks at the timers of
    // these units only (a dozen columns of every unit a tick were most of
    // its cost).
    ['stOn', Uint8Array, 1],
    // 1 while its attack timer, attack flash or worker transfer cooldown may
    // run (set where they are set above 0, at a slot's start; cleared by
    // SIM_KERNEL_STATUS when all three are out): the kernel reads those three
    // columns of these units only.
    ['tmOn', Uint8Array, 1],
    // Dead at the unit pass's start (written by SIM_KERNEL_MOVE for every
    // slot): what decisions in the pass go by (_unitTickDead).
    ['dead0', Uint8Array, 1],
    // Laser beams (tower.js laserBeamsTick): 1 immune to towers, 2 laser
    // resistant (its type's); the damage not yet reported, the last beam that
    // hit it, its report this tick.
    ['lzFlags', Uint8Array, 1], ['lzAcc', Float32Array, 1], ['lzBeam', Int32Array, 1], ['lzEv', Uint8Array, 1],
    // Its position at the start of the unit pass (the pre-pass copies it):
    // where other units see it during the pass (see _unitTickX).
    ['x0', Int32Array, 1], ['y0', Int32Array, 1],
    // Flow mode: 1 for a worker at its task (handed back on its check ticks,
    // see WORKER_MOVE_CHECK_TICKS), 2 for one the player sent (MANUAL_MOVE:
    // its check does nothing while it has a way, so it is not handed back).
    ['mvWk', Uint8Array, 1],
    // Unit._navLastD (-1 none): its distance to a group's destination last
    // tick (arriving in a crowd), one value for Unit.update and the kernel.
    ['mvNavLD', Float32Array, 1],
    // Unit._sepMoved: 1 when it moved by itself last tick (the separation
    // started at the next tick's start reads it; see separationStart).
    ['sepMov', Uint8Array, 1],
    // Unit.dead (1 dead), so the tick's dead-unit pass need not read objects.
    ['dead', Uint8Array, 1],
    // Where the spatial index and the visibility coverage have the unit
    // (Unit accessors _spatialTile... and _vsGen...; see chunk.js and
    // renderer.js), so their updates need not read the unit object.
    ['spTile', Int32Array, 1], ['spArea', Int32Array, 1], ['spOwner', Int8Array, 1], ['spEpoch', Int32Array, 1],
    ['spType', Int16Array, 1], ['vsGen', Int32Array, 1], ['vsR', Int8Array, 1],
    ['vsA', Int32Array, 1], ['vsP1', Int8Array, 1], ['vsP2', Int8Array, 1],
    // Unit.maxEnergy as of its last stat change (simUnitMaxE, where the
    // stats are applied), and 1 while the slot holds a unit: the healer
    // candidates' kernel (worker.js healerCandidatesStep).
    ['maxE', Float32Array, 1], ['live', Uint8Array, 1],
    // A chunk move the movement kernel made (spMvOwn: its owner + 1, 0
    // none; from spMvOld to spMvNew): counted at the unit pass's end
    // (SIM_KERNEL_SP_COUNTS, see spatialCountsDeferEnd). mvBlk: a node step
    // its owner's budget could not cover (the budget glyph, set after it).
    ['spMvOld', Int32Array, 1], ['spMvNew', Int32Array, 1], ['spMvOwn', Int8Array, 1], ['mvBlk', Uint8Array, 1],
    // Flow movement's committed step (SIM_STEER_TICKS): its destination tile
    // (-1 none), the tick and the step its last steer committed.
    ['mvCD', Int32Array, 1], ['mvCT', Int32Array, 1], ['mvCVx', Float32Array, 1], ['mvCVy', Float32Array, 1],
    // (The tile it steered in, and for how many ticks the step holds.)
    ['mvCTl', Int32Array, 1], ['mvCN', Uint8Array, 1],
    // Flow mode: its navigation profile (flownav.js navProfileOf: ground, air,
    // a walk class), whose fields and walls the kernel reads.
    ['mvNP', Uint8Array, 1],
    // Unit.pathIsFallbackAstar && Unit._pendingPathTarget (their accessors):
    // the separation's commit retries such a unit's path on its retry ticks.
    ['mvPF', Uint8Array, 1],
    // A drive-by shooter the movement kernel moved whose look found
    // something (SIM_KERNEL_DRIVEBY): its shot at its turn (simDriveByFire).
    ['mvFire', Uint8Array, 1],
    // A unit's attack cooldown and damage (its stats: simMoveStatsChanged),
    // for the attacks the movement kernel makes for held units.
    ['atkCd', Float32Array, 1], ['atkDmg', Float32Array, 1], ['atkSty', Uint8Array, 1],
    // The worker search registry (worker.js wsRegister): an idle worker's
    // search, done on the tier (wsKind 0 none, 1 collector, 3 builder or
    // salvager, 4 healer, 5 researcher): its resource type, the tick it
    // registered, its origin (NaN: where it stands; and until wsOU too), its
    // radius, anchor, area steps, need bits, jitter id, current target tile,
    // own reserved tile.
    ['wsKind', Uint8Array, 1], ['wsCfg', Int8Array, 1], ['wsT', Int32Array, 1], ['wsOU', Int32Array, 1],
    ['wsOx', Float32Array, 1], ['wsOy', Float32Array, 1], ['wsR', Float32Array, 1], ['wsAx', Float32Array, 1], ['wsAy', Float32Array, 1],
    ['wsAk', Int8Array, 1], ['wsNeed', Int32Array, 1], ['wsJid', Int32Array, 1], ['wsCur', Int32Array, 1], ['wsMy', Int32Array, 1],
    // Its unit type's index in simUnitTypeIndex's list (-1 not known), and
    // its upkeep bin (main.js upkeepUnitRefresh; -1 none).
    ['upT', Int16Array, 1], ['upB', Int32Array, 1],
    // The separation's tick-start copy (SIM_KERNEL_STATUS writes it with
    // x0/y0, its tier job reads it while the pass moves units): dead, radius,
    // layer; and the push it found that is still to be applied next tick
    // (sepCx/sepCy: a push is spread over two ticks).
    ['sepD0', Uint8Array, 1], ['sepR0', Float32Array, 1], ['sepL0', Uint8Array, 1],
    ['sepCx', Float32Array, 1], ['sepCy', Float32Array, 1],
    // The version of its (owner, type) stat tables its stats were applied at
    // (things_utils.js _unitStatsVerOf).
    ['esVer', Int32Array, 1],
    // Its effective stat tables' row (things_utils.js _effRowAttach; -1: its own).
    ['statRow', Int32Array, 1],
    // Unit._forcedTargetLastSeenX/Y (NaN: null): a forced target's last seen
    // position, which the movement kernel writes for forced holds and chases
    // (mvFlags 8); the values before its write (fLsPX/fLsPY) and the tick of
    // it (fLsT), put back when the unit runs Unit.update after all that tick.
    ['fLsX', Float32Array, 1], ['fLsY', Float32Array, 1], ['fLsPX', Float32Array, 1], ['fLsPY', Float32Array, 1], ['fLsT', Int32Array, 1],
    // 1 while Unit.targetBuilding holds a structure (its accessor writes it):
    // the acquisition tier skips units attacking a unit (SIM_KERNEL_ACQ_SNAP).
    ['acqB', Uint8Array, 1],
    // The combat brain's instruction (SIM_KERNEL_COMBAT_BRAIN on a helper
    // lane, committed by SIM_KERNEL_COMBAT_COMMIT): cmMode 0 none (the order's
    // own movement), 1 hold (stand, fire when the timer is out), 2 chase
    // (step toward the target); the target's slot and id. isWk: a worker
    // (the brain leaves workers alone).
    ['cmMode', Uint8Array, 1], ['cmT', Int32Array, 1], ['cmTId', Int32Array, 1], ['isWk', Uint8Array, 1],
    // The digest of its hashed object fields (SIM_HASH_DIGEST_FIELDS: their
    // setters keep it), hashed with its columns (SIM_KERNEL_SNAP_REGION).
    ['hObj', Int32Array, 1],
    // Its flow route's end tile (Unit._routeEnd; -1 none) and its navigation
    // profile as of then; its path's last flow node's field (key * 2 + wide,
    // -1 none; the path setter's): what the field sweep keeps
    // (flownav.js navFieldsSweepStep), from columns.
    ['rtEnd', Int32Array, 1], ['nvProf', Int8Array, 1], ['nvPK', Int32Array, 1],
    // 1 while its worker state is IDLE (the workerState setter's: the game
    // stats count idle workers from columns).
    ['wkIdle', Uint8Array, 1],
    // Its worker search's takes in a row that found nothing it could have
    // (worker.js _wsTakeSome; the search tier backs off: k_ws_select).
    ['wsFail', Uint8Array, 1],
    // The tick's hits on it (SIM_KERNEL_HITS, cleared by HITS_APPLY): their
    // damage in 1/16ths, whether listed, statuses (bits), the largest fire
    // and poison damage (Float32 bits), a scout's watch key.
    ['hAcc', Int32Array, 1], ['hTouch', Uint8Array, 1], ['hSty', Uint8Array, 1], ['hBurnD', Int32Array, 1], ['hPoiD', Int32Array, 1], ['hWatchK', Int32Array, 1],
    // Unit.watchedByTeam (-1 none: the hits kernel sets it with the watch)
    // and, for a scout, the watch its swoop gives (ticks; atkDmg's twin).
    ['wTeam', Int8Array, 1], ['atkWatch', Int32Array, 1]];
// Accessor defaults (the "not indexed / not registered" values).
const SIM_SPATIAL_DEFAULTS = { spTile: -1, spArea: -2, spOwner: -1, spEpoch: 0, spType: -1, vsGen: 0, vsR: -1, vsA: -1, vsP1: -1, vsP2: -1 };
let _simUnitState = null;
// Per-slot inputs of the collision pass, kept current by the spatial index
// (not read from unit objects every tick): the unit's chunk, or
// SIM_SEP_ABSENT when it is not indexed, and its layer (0 ground, 1 flying,
// 2 mole).
const SIM_SEP_ABSENT = 0xFFFFFF;

function simUnitStateReset() {
    if (typeof spatialIndexInvalidate === 'function') spatialIndexInvalidate();
    // A whole-world replacement needs no slot recycling. Old objects retain
    // their own generation's columns, but no registry keeps its owners alive.
    _simUnitState = null;
    for (const k of SIM_UNIT_COLUMNS) simParallelBind('unit.' + k, null);
}

// The columns object has one fixed shape, every column declared up front by
// name: built by adding computed keys one by one, V8 turned it into a
// dictionary, and every unit accessor (x, y, owner...) did a hash lookup.
let _SimUnitColumns = null;
function _simUnitColumnsObject() {
    if (!_SimUnitColumns) {
        const names = [...SIM_UNIT_COLUMNS, ...SIM_MOVE_COLUMNS.map(c => c[0]), 'sepKey', 'mvNodes'];
        _SimUnitColumns = new Function(names.map(n => 'this.' + n + ' = null;').join(' ') + ' ' + SIM_UNIT_OBJ_FIELDS.map(k => 'this.oc_' + k + ' = [];').join(' '));
    }
    return new _SimUnitColumns();
}

// Slots released this tick become free for new units (spatialIndexRebuild,
// at the start of a tick).
function simUnitStateReleaseFreed() {
    const S = _simUnitState;
    if (!S || !S.freeLater || !S.freeLater.length) return;
    for (const s of S.freeLater) S.free.push(s);
    S.freeLater.length = 0;
}

// The columns live in the wasm heap (simHeapArray: the Rust kernels read
// them in place). Old unit objects keep their generation's columns object
// (a whole-world replacement, a compaction): its arrays go back to the
// heap only once nothing reaches that object (_simUnitColumnsGone), never
// while a stale unit could still read or write them.
const _simUnitColumnsGone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(h => { for (const a of h.arrays) simHeapFree(a); }) : null;
function _simUnitColumnsHeld(S) {
    if (!S.held) { S.held = { arrays: [] }; if (_simUnitColumnsGone) _simUnitColumnsGone.register(S.columns, S.held); }
    const list = S.held.arrays;
    list.length = 0;
    for (const k of SIM_UNIT_COLUMNS) list.push(S.columns[k]);
    for (const [k] of SIM_MOVE_COLUMNS) list.push(S.columns[k]);
    list.push(S.sepKey, S.sepLayer);
}
function _simUnitStateNew() {
    return _simUnitState = { cap: 0, owners: [], free: [], columns: _simUnitColumnsObject(), stamp: null, epoch: 0, unitsRef: null, held: null };
}
// Room for n more units in one step (before many are made at once: the
// match's starting units, a restore): growing by half each time kept every
// size's columns until the heap could reuse them (2-3 times the last).
function simUnitStateReserve(n) {
    // (Nothing to make: no state made either; one is always made with its
    // columns, simUnitStateAllocate.)
    if (!(n > 0)) return;
    const S = _simUnitState || _simUnitStateNew();
    const need = S.owners.length + Math.max(0, n - S.free.length);
    if (need > S.cap) _simUnitStateGrow(S, Math.max(1024, Math.ceil(need / 4096) * 4096));
}
function simUnitStateAllocate(u) {
    let S = _simUnitState || _simUnitStateNew();
    const reused = S.free.length > 0;
    const s = reused ? S.free.pop() : S.owners.length;
    // (Grown by half, in whole 4096-slot steps: doubling left up to half of
    // ~850 bytes a slot unused, 1M slots for 600k units.)
    if (s >= S.cap) _simUnitStateGrow(S, Math.max(1024, Math.ceil(S.cap * 1.5 / 4096) * 4096));
    // A slot that held a unit before: every column zeroed, as a fresh slot's
    // (its last unit's kernel state (committed steps, steady windows, flags,
    // speeds) must not reach the new one: which slot a unit gets depends on
    // the peer's history, a restore's above all, so a leftover there made
    // peers diverge).
    if (reused) { (_simSlotZero || (_simSlotZero = _simSlotZeroFn()))(S.columns, s); S.sepLayer[s] = 0; }
    _simUnitSlotStart(S, s, u);
}
// (One straight-line function over every column: a fill call per column was
// ~10 us a unit.)
let _simSlotZero = null;
function _simSlotZeroFn() {
    const body = [];
    for (const k of SIM_UNIT_COLUMNS) body.push('C.' + k + '[s] = 0;');
    for (const [k, , per] of SIM_MOVE_COLUMNS) body.push(per === 1 ? 'C.' + k + '[s] = 0;' : 'C.' + k + '.fill(0, s * ' + per + ', s * ' + per + ' + ' + per + ');');
    return new Function('C', 's', body.join('\n'));
}
function _simUnitStateGrow(S, cap) {
    // (The arrays replaced: given back to the heap, see above.)
    {
        const old = [];
        for (const k of SIM_UNIT_COLUMNS) {
            const a = simHeapArray(_simUnitColumnType(k), cap);
            if (S.columns[k]) { a.set(S.columns[k]); old.push(S.columns[k]); }
            S.columns[k] = a;
            simParallelBind('unit.' + k, a);
        }
        for (const [k, Type, per] of SIM_MOVE_COLUMNS) {
            const a = simHeapArray(Type, cap * per);
            if (S.columns[k]) { a.set(S.columns[k]); old.push(S.columns[k]); }
            S.columns[k] = a;
            simParallelBind('unit.' + k, a);
        }
        // (The object fields' arrays: packed, as long as the columns; written
        // by index, never past the end: no sparse, dictionary-mode arrays.)
        for (const k of SIM_UNIT_OBJ_FIELDS) {
            const was = S.columns['oc_' + k], a = new Array(cap).fill(undefined);
            if (was) for (let i = 0, n = Math.min(was.length, cap); i < n; i++) a[i] = was[i];
            S.columns['oc_' + k] = a;
        }
        const stamp = new Uint32Array(cap);
        if (S.stamp) stamp.set(S.stamp);
        S.stamp = stamp;
        const sepKey = simHeapArray(Uint32Array, cap), sepLayer = simHeapArray(Uint8Array, cap);
        sepKey.fill(SIM_SEP_ABSENT);
        if (S.sepKey) { sepKey.set(S.sepKey); sepLayer.set(S.sepLayer); old.push(S.sepKey, S.sepLayer); }
        S.sepKey = sepKey; S.sepLayer = sepLayer; S.columns.sepKey = sepKey;
        simParallelBind('unit.sepKey', sepKey); simParallelBind('unit.sepLayer', sepLayer);
        S.cap = cap;
        if (!S.pathPool) { S.pathPool = { next: 0, free: [], cap: 0, held: { array: null } }; S.columns.mvNodes = simHeapArray(Int32Array, 1); S.pathPool.held.array = S.columns.mvNodes; if (_simPathPoolsGone) _simPathPoolsGone.register(S.pathPool, S.pathPool.held); simParallelBind('unit.mvNodes', S.columns.mvNodes); }
        _simUnitColumnsHeld(S);
        for (const a of old) simHeapFree(a);
    }
}
// Slot s taken by unit u: its defaults, and u's accessors pointed at it.
function _simUnitSlotStart(S, s, u) {
    S.sepKey[s] = SIM_SEP_ABSENT;
    S.columns.mvOn[s] = 0; S.columns.mvOut[s] = 0; S.columns.mvWk[s] = 0; S.columns.dead[s] = 0; S.columns.mvNav[s * SIM_NAV_STRIDE] = -1; S.columns.mvNavLD[s] = -1; S.columns.mvFloor[s] = -1; S.columns.sepMov[s] = 0;
    S.columns.esOk[s] = 0; S.columns.esTaken[s] = 0; S.columns.stAcc[s] = 0; S.columns.stEv[s] = 0; S.columns.stOn[s] = 1; S.columns.tmOn[s] = 1; S.columns.lzAcc[s] = 0; S.columns.sepCx[s] = 0; S.columns.sepCy[s] = 0; S.columns.esVer[s] = -1; S.columns.statRow[s] = -1;
    S.columns.fLsX[s] = NaN; S.columns.fLsY[s] = NaN; S.columns.fLsT[s] = -1;
    S.columns.wkWx[s] = typeof u._bwx === 'number' ? u._bwx : NaN; S.columns.wkWy[s] = typeof u._bwy === 'number' ? u._bwy : NaN;
    S.columns.wkLmt[s] = typeof u._bmt === 'number' && u._bmt === Math.floor(u._bmt) ? u._bmt : -2147483648;
    for (const k of SIM_UNIT_LEVEL_COLUMNS) S.columns[k][s] = NaN;
    for (const k in SIM_SPATIAL_DEFAULTS) S.columns[k][s] = SIM_SPATIAL_DEFAULTS[k];
    S.owners[s] = u;
    S.columns.mvPath[s] = -1;
    S.columns.live[s] = 1; S.columns.maxE[s] = Number(u.maxEnergy); S.columns.spMvOwn[s] = 0; S.columns.mvBlk[s] = 0; S.columns.mvCD[s] = -1; S.columns.wsKind[s] = 0;
    // (Tick-stamped answers of the slot's last unit are not this one's.)
    S.columns.acqB[s] = 0; S.columns.cmMode[s] = 0; S.columns.cmT[s] = -1; S.columns.cmTId[s] = 0; S.columns.isWk[s] = u.workerType ? 1 : 0;
    S.columns.cbTick[s] = -1; S.columns.cbT[s] = -1; S.columns.dbTick[s] = -1; S.columns.dbT[s] = -1; S.columns.cwTick[s] = -1; S.columns.upT[s] = -1; S.columns.upB[s] = -1;
    // (Its object fields unset: their digest that of none.)
    _simUnitObjClear(S.columns, s);
    S.columns.hObj[s] = _simHDigest0();
    S.columns.rtEnd[s] = -1; S.columns.nvProf[s] = 0; S.columns.nvPK[s] = -1; S.columns.wkIdle[s] = 0; S.columns.wsFail[s] = 0;
    S.columns.hAcc[s] = 0; S.columns.hTouch[s] = 0; S.columns.hSty[s] = 0; S.columns.hBurnD[s] = 0; S.columns.hPoiD[s] = 0; S.columns.hWatchK[s] = 0;
    S.columns.wTeam[s] = -1; S.columns.atkWatch[s] = 0;
    Object.defineProperties(u, { _us: { value: S.columns, writable: true }, _si: { value: s, writable: true }, _det: { value: null, writable: true },
        _path: { value: null, writable: true }, _ws: { value: undefined, writable: true }, _wnr: { value: undefined, writable: true }, _tb: { value: null, writable: true },
        _pfa: { value: u._pfa, writable: true }, _ppt: { value: u._ppt, writable: true } });
    S.columns.mvPF[s] = u._pfa && u._ppt ? 1 : 0;
}

// Removed units may still be attack targets, selected, or referenced in a
// snapshot. Detach their values before reusing the slot; stale object references
// must never read or overwrite a newly spawned unit.
let _simDetValues = null;
// (A slot's object fields unset; on detach the references let go.)
const _simUnitObjClear = new Function('C', 's', SIM_UNIT_OBJ_FIELDS.map(k => 'C.oc_' + k + '[s] = undefined;').join(' '));
function _simDetValuesCtor() {
    const body = SIM_UNIT_ACCESSOR_COLUMNS.map(k => 'this.' + k + ' = C.' + k + '[s]' + (SIM_UNIT_POS_COLUMNS.has(k) ? ' * ' + SIM_POS_INV : '') + ';').join(' ')
        + ' ' + SIM_UNIT_OBJ_FIELDS.map(k => 'this.' + k + ' = C.oc_' + k + '[s];').join(' ') + ' this._routeEnd = C.rtEnd[s]; this.watchedByTeam = C.wTeam[s];'
        + ' this.dead = C.dead[s] === 1; this._navLastD = C.mvNavLD[s]; this._floorTile = C.mvFloor[s]; this._sepMoved = C.sepMov[s];'
        + ' this._statsBehind = false; this._forcedTargetLastSeenX = null; this._forcedTargetLastSeenY = null;'
        + ' { const a = C.wkWx[s], b = C.wkWy[s], m = C.wkLmt[s]; this._builderLastWatchX = a === a ? a : undefined; this._builderLastWatchY = b === b ? b : undefined; this._builderLastMoveTick = m === -2147483648 ? undefined : m; }';
    return new Function('C', 's', body);
}
function simUnitStateDetach(S, s) {
    const u = S.owners[s];
    if (!u) return;
    // Its values move to one plain object the accessors fall back to (a
    // property definition per column made releasing many units slow; one
    // constructor: one shape, no dictionary transitions per key).
    // (Its row's tables as its own.)
    if (S.columns.statRow[s] >= 0 && typeof _effRowObj !== 'undefined') u._effRowKeep(_effRowObj[S.columns.statRow[s]]);
    S.columns.statRow[s] = -1;
    const values = new (_simDetValues || (_simDetValues = _simDetValuesCtor()))(S.columns, s);
    values._statsBehind = typeof _unitStatsBehind === 'function' ? _unitStatsBehind(u, S.columns.esVer[s]) : false;
    { const lx = S.columns.fLsX[s], ly = S.columns.fLsY[s]; values._forcedTargetLastSeenX = lx === lx ? lx : null; values._forcedTargetLastSeenY = ly === ly ? ly : null; }
    u._det = values;
    // (Its path window back to the pool: the slot's next unit starts with none.)
    simUnitPathRelease(S.columns, s);
    u._us = null; u._si = -1;
    _simUnitObjClear(S.columns, s);
    S.sepKey[s] = SIM_SEP_ABSENT;
    S.columns.mvOn[s] = 0; S.columns.mvOut[s] = 0; S.columns.live[s] = 0;
    // (Reused from the next unit index rebuild on: its entries name units
    // by slot for the rest of the tick, see simUnitStateReleaseFreed.)
    S.owners[s] = null; (S.freeLater || (S.freeLater = [])).push(s);
}

// The spatial index reports where a unit is (chunk key, layer) or that it
// left (key SIM_SEP_ABSENT).
function simUnitSetSepKey(u, key, layer) {
    const S = _simUnitState;
    if (!S || u._us !== S.columns) return;
    S.sepKey[u._si] = key;
    S.sepLayer[u._si] = layer;
}

// Every slot leaves the index (the spatial buckets were replaced).
function simUnitClearSepKeys() {
    if (_simUnitState) _simUnitState.sepKey.fill(SIM_SEP_ABSENT);
}

// After a whole-world restore (snapDecodeState): the restored units took
// new slots above the old ones, which the collection frees: every per-slot
// kernel would walk the gap for the rest of the match. When over a third of
// the slots would be free, the units of the units list move into slots 0..
// (in its order) of a new state: every column copied, the slots other units
// hold in cbT and dbT (the tiers' results) moved with them; the rest
// detached. Slots are local to each peer (no decision goes by them), and
// at a restore every slot-keyed cache was dropped (snapFlushHistoryCaches,
// the disarm, the index made again).
// `force` (a whole-world restore): always, so every peer that restores the
// same world has the same layout whatever it held before.
function simUnitStateCompact(force = false) {
    const S = _simUnitState;
    if (!S) return false;
    let live = 0;
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u && u._us === S.columns && S.owners[u._si] === u) live++; }
    if (!force && S.owners.length - live < Math.max(4096, S.owners.length / 3)) return false;
    if (typeof simParallelBackgroundWait === 'function' && typeof SIM_PAR_BG_LANES === 'number') for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) simParallelBackgroundWait(lane);
    const old = S.columns, n0 = S.owners.length, map = new Int32Array(n0).fill(-1);
    const cap = Math.max(1024, Math.ceil(live * 1.125 / 4096) * 4096);
    const N = { cap, owners: [], free: [], columns: _simUnitColumnsObject(), stamp: new Uint32Array(cap), epoch: 0, unitsRef: units, held: null };
    const C = N.columns;
    N.pathPool = S.pathPool; C.mvNodes = old.mvNodes;
    for (const k of SIM_UNIT_COLUMNS) C[k] = simHeapArray(_simUnitColumnType(k), cap);
    for (const [k, Type, per] of SIM_MOVE_COLUMNS) C[k] = simHeapArray(Type, cap * per);
    N.sepKey = simHeapArray(Uint32Array, cap); N.sepLayer = simHeapArray(Uint8Array, cap);
    N.sepKey.fill(SIM_SEP_ABSENT); C.sepKey = N.sepKey;
    // (The old columns go back to the heap once no unit reaches them.)
    _simUnitColumnsHeld(N);
    // Units first, then the columns, one at a time, in runs of consecutive
    // slots (restored units hold consecutive slots in list order: a few
    // block copies). (Per unit and column, through the column's name, it was
    // ~13 s at 200k units.)
    let ns = 0;
    const runs = [];
    for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (!u || u._us !== old || S.owners[u._si] !== u) continue;
        const s = u._si, r = runs.length;
        if (r && runs[r - 2] + runs[r - 1] === s) runs[r - 1]++;
        else runs.push(ns, s, 1);
        N.owners[ns] = u; map[s] = ns;
        u._us = C; u._si = ns;
        ns++;
    }
    for (const k of SIM_UNIT_COLUMNS) _simCopyRuns(old[k], C[k], runs, 1);
    for (const [k, , per] of SIM_MOVE_COLUMNS) _simCopyRuns(old[k], C[k], runs, per);
    _simCopyRuns(S.sepKey, N.sepKey, runs, 1); _simCopyRuns(S.sepLayer, N.sepLayer, runs, 1);
    // (The object fields' arrays: packed at the new size, copied the same way.)
    for (const k of SIM_UNIT_OBJ_FIELDS) {
        const a = old['oc_' + k], b = C['oc_' + k] = new Array(cap).fill(undefined);
        for (let r = 0; r < runs.length; r += 3) for (let to = runs[r], from = runs[r + 1], e = from + runs[r + 2]; from < e; to++, from++) b[to] = a[from];
    }
    for (let s = 0; s < ns; s++) {
        const a = C.cbT[s], b = C.dbT[s];
        if (a >= 0) C.cbT[s] = a < n0 ? map[a] : -1;
        if (b >= 0) C.dbT[s] = b < n0 ? map[b] : -1;
    }
    // The rest (removed, not yet collected): detached from the old state.
    for (let s = 0; s < n0; s++) if (S.owners[s] && map[s] < 0) simUnitStateDetach(S, s);
    _simUnitState = N;
    for (const k of SIM_UNIT_COLUMNS) simParallelBind('unit.' + k, C[k]);
    for (const [k] of SIM_MOVE_COLUMNS) simParallelBind('unit.' + k, C[k]);
    simParallelBind('unit.mvNodes', C.mvNodes);
    simParallelBind('unit.sepKey', N.sepKey); simParallelBind('unit.sepLayer', N.sepLayer);
    if (typeof unitSlotMapInvalidate === 'function') unitSlotMapInvalidate();
    return true;
}

// Copies runs [to, from, count, ...] of slots (per values a slot) from a to b.
function _simCopyRuns(a, b, runs, per) {
    for (let r = 0; r < runs.length; r += 3) {
        const to = runs[r] * per, from = runs[r + 1] * per, n = runs[r + 2] * per;
        if (n > 32) b.set(a.subarray(from, from + n), to);
        else for (let j = 0; j < n; j++) b[to + j] = a[from + j];
    }
}

// Slots of removed units are reclaimed by a sliced sweep: every removal
// path marks the unit dead, and each tick checks 1/SIM_UNIT_COLLECT_SLICES
// of the slots (a dead unit keeps its values, detached, for any reference
// still holding it).
const SIM_UNIT_COLLECT_SLICES = 64;
function simUnitStateCollect(all = false) {
    const S = _simUnitState;
    if (!S) return;
    const owners = S.owners;
    // The units array was replaced (a new match, a restore): every slot whose
    // unit is not in it is released at once (they need not be dead).
    if (S.unitsRef !== units) {
        S.unitsRef = units;
        if (++S.epoch === 0xffffffff) { S.stamp.fill(0); S.epoch = 1; }
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u && u._us === S.columns) S.stamp[u._si] = S.epoch;
        }
        for (let s = 0; s < owners.length; s++) if (owners[s] && S.stamp[s] !== S.epoch) simUnitStateDetach(S, s);
        return;
    }
    // (A slot's unit reads dead from the slot's column: the typed column, not
    // the unit's getter, ~10x faster over a slice.)
    const step = all ? 1 : SIM_UNIT_COLLECT_SLICES, DEAD = S.columns.dead;
    for (let s = all ? 0 : (typeof gameTime === 'number' ? gameTime : 0) % step; s < owners.length; s += step) {
        if (DEAD[s] !== 1) continue;
        const u = owners[s];
        if (u && u._us === S.columns && u._si === s) simUnitStateDetach(S, s);
        else if (u && u.dead) simUnitStateDetach(S, s);
    }
}

// Serialization enumerates gameplay fields, including prototype columns.
function simUnitStateKeys(u) {
    const keys = Object.keys(u);
    // (Structures: their table accessors' names, see structTableKeys.)
    if (u._stT !== undefined && typeof structTableKeys === 'function') return structTableKeys(u, keys);
    if (u._us || u._det) for (const k of SIM_UNIT_ACCESSOR_COLUMNS) keys.push(k);
    if (u instanceof Unit) for (const k of SIM_UNIT_EXTRA_ACCESSORS) if (!Object.prototype.hasOwnProperty.call(u, k)) keys.push(k);
    return keys;
}

// Scratch sized by population: the expected count plus 12.5% headroom, in
// whole 4096-element blocks (doubling left up to half of each large pool
// unused, and its copies with it).
function simReserveCap(n, min = 1024) { return Math.max(min, Math.ceil(n * 1.125 / 4096) * 4096); }

// Explicit paths alone own a window. Flow movers keep only a -1 handle.
function simUnitPathWindow(c, s) {
    const S = _simUnitState;
    if (!S || S.columns !== c) throw new Error('path window belongs to retired state');
    const P = S.pathPool;
    let h = c.mvPath[s];
    if (h < 0) { h = P.free.length ? P.free.pop() : P.next++; c.mvPath[s] = h; }
    if (h >= P.cap) {
        const cap = Math.max(64, Math.ceil((h + 1) * 1.125 / 64) * 64), old = c.mvNodes;
        c.mvNodes = simHeapArray(Int32Array, cap * SIM_MOVE_WINDOW);
        c.mvNodes.set(old); P.cap = cap; P.held.array = c.mvNodes;
        simParallelBind('unit.mvNodes', c.mvNodes); simHeapFree(old); _simUnitColumnsHeld(S);
    }
    return h * SIM_MOVE_WINDOW;
}
function simUnitPathRelease(c, s) {
    const S = _simUnitState;
    if (S && S.columns === c && S.pathPool && c.mvPath[s] >= 0) { S.pathPool.free.push(c.mvPath[s]); c.mvPath[s] = -1; }
}

const _simPathPoolsGone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(h => simHeapFree(h.array)) : null;
// Schema is also consumed by allocation reports and ABI validation tooling.
const SIM_UNIT_SCHEMA = Object.freeze((() => {
    const out = Object.create(null);
    for (const [name, Type, count] of [...SIM_UNIT_COLUMNS.map(k => [k, _simUnitColumnType(k), 1]), ...SIM_MOVE_COLUMNS]) {
        if (out[name]) throw new Error('Duplicate unit column: ' + name);
        out[name] = Object.freeze({ Type, count, bytes: Type.BYTES_PER_ELEMENT * count,
            snapshot: SIM_UNIT_ACCESSOR_COLUMNS.includes(name),
            group: /^(ws|wk)/.test(name) ? 'worker' : /^fLs/.test(name) ? 'forcedTarget' : 'unit',
            default: name in SIM_SPATIAL_DEFAULTS ? SIM_SPATIAL_DEFAULTS[name] : SIM_UNIT_LEVEL_COLUMNS.includes(name) || /^fLs[XY]$/.test(name) ? NaN : 0 });
    }
    return out;
})());
function simMemoryStats() {
    const S = _simUnitState, groups = {}, seen = new Set();
    for (const [name, a] of Object.entries(_simParReg)) {
        if (!ArrayBuffer.isView(a) || seen.has(a)) continue;
        seen.add(a); const k = name.split('.')[0]; groups[k] = (groups[k] || 0) + a.byteLength;
    }
    return { slots: S ? S.owners.length : 0, capacity: S ? S.cap : 0,
        bytesPerSlot: Object.values(SIM_UNIT_SCHEMA).reduce((n, e) => n + e.bytes, 5),
        pathWindows: S && S.pathPool ? S.pathPool.next - S.pathPool.free.length : 0,
        boundBytes: groups, heap: typeof simHeapStats === 'function' ? simHeapStats() : null };
}
