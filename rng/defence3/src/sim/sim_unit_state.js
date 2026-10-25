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
// The timers among them (in the status record, SIM_UNIT_ST_SIDE).
const SIM_STATUS_TIMER_COLUMNS = ['teleportHideTicks', 'burning', 'poisoned', 'frozen', 'wet', 'sandy', 'watched'];
// Stacks and levels (the effective-stats kernel, SIM_KERNEL_EFF_UNITS):
// NaN stands for a field not set (its accessor reads undefined).
const SIM_UNIT_LEVEL_COLUMNS = ['stackCount', 'unitLevel', 'baseLevel', 'effectiveStacks', 'effectiveLevel', '_lastAppliedEffectiveLevel'];
// Status records (sparse: most units have none): every status field but the
// transfer cooldown lives in a pool of records, unit.stIx the slot's (0 none:
// record 0 holds zeros, read by every other unit, never written). A write of
// anything but 0 takes a record first (simUnitSt; the hits kernel and floor
// traps take theirs on the helpers, k.rs st_take); SIM_KERNEL_STATUS gives it
// back once its timers are out and its damage is reported (its tick damages
// with it). [record field, type, the unit's accessor]. stDt / stEv: the status
// pre-pass's report this tick (the damage, the event), read right after it.
const SIM_UNIT_ST_SIDE = [['stTh', Uint16Array, 'teleportHideTicks'], ['stBu', Uint16Array, 'burning'], ['stPo', Uint16Array, 'poisoned'],
    ['stFr', Uint16Array, 'frozen'], ['stWe', Uint16Array, 'wet'], ['stSa', Uint16Array, 'sandy'], ['stWa', Uint16Array, 'watched'],
    ['stBd', Float32Array, 'burnTickDamage'], ['stPd', Float32Array, 'poisonTickDamage'], ['stId', Float32Array, 'iceTickDamage'],
    ['stAc', Float32Array, '_dotPending'], ['stDt', Float32Array, null], ['stEv', Uint8Array, null]];
// (Accessor name -> its record field.)
const SIM_UNIT_ST_FIELD = Object.fromEntries(SIM_UNIT_ST_SIDE.filter(e => e[2]).map(e => [e[2], e[0]]));
const SIM_UNIT_COLUMNS = ['id', 'owner', 'x', 'y', 'prevX', 'prevY', 'vx', 'vy',
    'energy', 'r', 'collisionR', 'pathIndex', 'commandState', 'attackTimer', 'attackFlash', 'workerTransferCooldown', ...SIM_UNIT_LEVEL_COLUMNS];
// Columns holding whole numbers only (ids, owners, commands, tick counts):
// 32-bit integers (the rest Float32: fractions, and NaN for "not set" in the
// level columns; tests/storage-abi.test.cjs checks the Rust twins' types).
const SIM_UNIT_INT_COLUMNS = new Set(['id', 'owner', 'commandState', 'attackFlash', 'teleportHideTicks', 'burning', 'poisoned', 'frozen', 'wet', 'sandy', 'watched', 'workerTransferCooldown']);
// (Narrower where the values fit, read every tick by most kernels: owners
// Int8 (players, -1 none), commands and the attack flash timer Uint8.)
// Status timers (ticks left) Uint16, saturating at SIM_TIMER_MAX (~55 min):
// stores clamp to 0..SIM_TIMER_MAX (the setters, unit.js; Rust: sat16).
const SIM_TIMER_MAX = 65535;
const SIM_UNIT_U16_TIMERS = ['teleportHideTicks', 'burning', 'poisoned', 'frozen', 'wet', 'sandy', 'watched', 'workerTransferCooldown'];
// Levels Int8 (1..MAX_THING_LEVEL; 0 not set: NaN stores as 0, the accessors read undefined).
const SIM_UNIT_NARROW_COLUMNS = { owner: Int8Array, commandState: Uint8Array, attackFlash: Uint8Array,
    unitLevel: Int8Array, baseLevel: Int8Array, effectiveLevel: Int8Array, _lastAppliedEffectiveLevel: Int8Array,
    ...Object.fromEntries(SIM_UNIT_U16_TIMERS.map(k => [k, Uint16Array])) };
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
const SIM_UNIT_OBJ_FIELDS = ['holdPosition',
    'workerTarget', 'workerTargetType', 'carryingValue', '_workerReservedTileIndex', 'builderHasMaterial', 'healerHasMaterial', 'researcherHasMaterial',
    '_astarBudgetRetryTick', '_scoutTarget', 'workerType'];
// (Statements a field's setter runs too, with c the columns, s the slot, v
// the value: columns kept from it.)
const SIM_UNIT_OBJ_DEFAULTS = {};
const SIM_UNIT_OBJ_HOOKS = { workerType: 'c.isWk[s] = v ? 1 : 0; if (v) simUnitWk(c, s);', holdPosition: 'c.holdF[s] = v ? 1 : 0;' };
const SIM_UNIT_EXTRA_ACCESSORS = ['path', 'targetBuilding', 'targetPos', '_routeKey', 'targetUnit', 'forcedAttackTarget', '_attackMoveGx', '_attackMoveGy', 'pathIsFallbackAstar', '_pendingPathTarget', 'workerState', '_workerNextIdleRetargetTick', 'dead', '_navLastD', '_floorTile', '_sepMoved', '_statsBehind', '_forcedTargetLastSeenX', '_forcedTargetLastSeenY',
    '_builderLastWatchX', '_builderLastWatchY', '_builderLastMoveTick', '_routeEnd', 'watchedByTeam', ...SIM_UNIT_OBJ_FIELDS,
    // (Damage not reported yet: unit.js _dotPending.)
    '_dotPending', '_laserPending', '_laserBeam',
    // (Its effective tables, as it has them: computed at its last stats
    // change, from the tables of then, so not derivable from the state; one
    // pool entry per distinct object, stat map entries by reference.)
    'preComputedEffective', 'preComputed'];
// Every field in the digest: the object fields and the accessors' plain
// values (structure target, pending way, worker state and its search). Not
// the unit type (set once, read everywhere: a plain field; a wrong type
// shows in its stats at once) nor the path (set on every re-route; where it
// leads shows in the position, velocity and pathIndex columns).
const SIM_HASH_DIGEST_FIELDS = [...SIM_UNIT_OBJ_FIELDS, '_pendingPathTarget', 'pathIsFallbackAstar', 'workerState', '_workerNextIdleRetargetTick'];

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
// A field's term for value v (key: _simHKey(field)). (Mixed after the
// multiply: as (key ^ v) * M alone, terms summed, one bit flipped in two
// fields cancelled out where their keys differ.)
function _simHTerm(key, v) { const t = Math.imul(key ^ _simHEnc(v), SIM_H_M); return Math.imul(t ^ (t >>> 15), 0x2c1b3c6d); }
// The digest at a slot's start: its fields unset (the structure target null,
// see _simUnitSlotStart).
let _simH0 = null;
function _simHDigest0() {
    if (_simH0 === null) { let h = 0; for (const k of SIM_HASH_DIGEST_FIELDS) h = (h + _simHTerm(_simHKey(k), k in SIM_UNIT_OBJ_DEFAULTS ? SIM_UNIT_OBJ_DEFAULTS[k] : undefined)) | 0; _simH0 = h; }
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
    ['mvLane', Float32Array, 1], ['mvSpent', Uint8Array, 1], ['mvReach', Uint8Array, 1], ['mvBase', Int32Array, 1], ['mvWlen', Uint8Array, 1],
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
    // (One record a slot, SIM_NAV_STRIDE words: T, D, V, W, G, N1, N2,
    // Far << 1 | Open; a steer touches one cache line. See simFlowLook.)
    ['mvNav', Int32Array, SIM_NAV_STRIDE],
    // The acquisition tier's structure result as committed (unit.js _acqTierStep): the tick, the range it was looked for with,
    // and the structure (its tile, -1 none). (Its unit target is the combat brain's: cmT.)
    ['cbTick', Int32Array, 1], ['cbRangeS', Float32Array, 1],
    // (And the structure it found: its tile, -1 none.)
    ['cbS', Int32Array, 1],
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
    ['esOk', Uint8Array, 1], ['esRad', Uint8Array, 1], ['esType', Int8Array, 1], ['esTaken', Int32Array, 1],
    // Its worker record (SIM_UNIT_WK_SIDE; 0: none, the defaults' record).
    ['wkIx', Int32Array, 1],
    // Its status record (SIM_UNIT_ST_SIDE; 0: none). SIM_KERNEL_STATUS looks
    // at the units holding one only (a dozen columns of every unit a tick
    // were most of its cost).
    ['stIx', Int32Array, 1],
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
    // Unit._sepMoved: bit 0 moved by itself; bit 1 still separating.
    // Bits 2..7 carry contact resistance through the stagger (0..63).
    ['sepMov', Uint8Array, 1],
    // Unit.dead (1 dead), so the tick's dead-unit pass need not read objects.
    ['dead', Uint8Array, 1],
    // Where the spatial index and the visibility coverage have the unit
    // (Unit accessors _spatialTile... and _vsGen...; see chunk.js and
    // renderer.js), so their updates need not read the unit object.
    ['spTile', Int32Array, 1], ['spArea', Int32Array, 1], ['spOwner', Int8Array, 1], ['spEpoch', Int32Array, 1],
    ['spType', Int16Array, 1], ['vsGen', Int32Array, 1], ['vsR', Int8Array, 1],
    ['vsA', Int8Array, 1], ['vsP1', Int8Array, 1], ['vsP2', Int8Array, 1],
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
    // What the presentation last saw changed (SIM_KERNEL_PV_MARKS, the tick's
    // end): the tick of its last visual change (moved, its energy, owner,
    // command or level changed, a flash, a timer, a fire target, made or
    // gone), and those values as of then (pvId -1: not alive).
    // (pvV: it had a velocity then.)
    // (pvOD: its order destination as the presentation shows it, the marks
    // kernel's: k_pv_marks.)
    ['pvOD', Int32Array, 1],
    // (pvS: a signature of those values, k_pv_marks; bit 31 the velocity.)
    ['pvAt', Int32Array, 1], ['pvS', Uint32Array, 1],
    // A unit's attack cooldown and damage (its stats: simMoveStatsChanged),
    // for the attacks the movement kernel makes for held units.
    ['atkSty', Uint8Array, 1],
    // Steps of several base ticks (simDk): the base ticks a unit stood ready
    // before the step's end when its attack timer ran out (its next attack's
    // shots, mv.rs fire), that attack's shots (k_hits), and the transfer
    // cooldown's carry (k_status). (The carries are state: snapshots take
    // them, SIM_UNIT_MOVE_SNAPSHOT_KEYS.)
    ['atkL', Uint8Array, 1], ['atkN', Uint8Array, 1], ['wtcL', Uint8Array, 1],
    // The worker search registry (worker.js wsRegister): an idle worker's
    // search, done on the tier (wsKind 0 none, 1 collector, 3 builder or
    // salvager, 4 healer, 5 researcher); the rest in its worker record.
    ['wsKind', Uint8Array, 1],
    // Its unit type's index in simUnitTypeIndex's list (-1 not known), and
    // its upkeep bin (main.js upkeepUnitRefresh; -1 none).
    ['upT', Int16Array, 1], ['upB', Int32Array, 1],
    // The separation's tick-start copy (SIM_KERNEL_STATUS writes it with
    // x0/y0, its tier job reads it while the pass moves units): dead, radius,
    // layer; and the push it found that is still to be applied next tick
    // (sepCx: separation velocity carried into the next update, x and y as
    // i16 halves, 1/256 px a base tick, as sepIv: mv.rs iv_pack).
    ['sepD0', Uint8Array, 1], ['sepR0', Float32Array, 1], ['sepL0', Uint8Array, 1],
    ['sepCx', Int32Array, 1],
    // Its intended velocity (its navigation's step of the last update per
    // base tick, before contacts) and the closing response it carries into
    // the next update: x and y as i16 halves, 1/256 px a base tick
    // (wasm/src/lib.rs sep_iv_x; written by mv.rs push4).
    ['sepIv', Int32Array, 1], ['sepCv', Int32Array, 1],
    // The version of its (owner, type) stat tables its stats were applied at
    // (things_utils.js _unitStatsVerOf).
    ['esVer', Int32Array, 1],
    // Its effective stat tables' row (things_utils.js _effRowAttach; -1: its own).
    ['statRow', Int16Array, 1],
    // Unit._forcedTargetLastSeenX/Y (NaN: null): a forced target's last seen
    // position, which the movement kernel writes for forced holds and chases
    // (mvFlags 8).
    ['fLsX', Float32Array, 1], ['fLsY', Float32Array, 1],
    // 1 while Unit.targetBuilding holds a structure (its accessor writes it):
    // the acquisition tier skips units attacking a unit (SIM_KERNEL_ACQ_SNAP).
    ['acqB', Uint8Array, 1],
    // The combat brain's instruction (SIM_KERNEL_COMBAT_BRAIN on a helper
    // lane, committed by SIM_KERNEL_COMBAT_COMMIT): cmMode 0 none (the order's
    // own movement), 1 hold (stand, fire when the timer is out), 2 chase
    // (step toward the target); the target's slot and id. isWk: a worker
    // (the brain leaves workers alone).
    ['cmMode', Uint8Array, 1], ['cmT', Int32Array, 1], ['cmTId', Int32Array, 1], ['isWk', Uint8Array, 1],
    // 1 while Unit.holdPosition is set (its setter's): the brain gives a held
    // unit no chase (k.rs k_combat_brain), only a stand and fire in range.
    ['holdF', Uint8Array, 1],
    // What the movement kernel leaves to the main thread this tick (unit.js unitEventsRun; 0 none): 1 a floor item it cannot
    // apply (a mine), 2 no way on, 3 a wait for a way that ended near its target, 4 not in the unit index, 5 a worker's AI look on
    // its way. Listed and cleared within the tick (SIM_KERNEL_UNIT_EVENTS).
    ['mvEv', Uint8Array, 1],
    // The unit's order state the kernels work on (unit.js accessors over them): its target unit (slot -1 none, and the id it
    // must still have), whether that target is forced (an order), the attack-move destination tile (amGx, amGy; -1 none) and
    // the structure it targets (its tile, -1 none). Hashed with the other columns (k_snap_units).
    // (And its route key, 1 the flow navigation's: unit._routeKey; its issued target position is mvTgX / mvTgY.)
    ['rkF', Uint8Array, 1],
    ['tuS', Int32Array, 1], ['tuId', Int32Array, 1], ['fatF', Uint8Array, 1], ['amGx', Int16Array, 1], ['amGy', Int16Array, 1], ['tbT', Int32Array, 1],
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
    // damage in 1/16ths, whether listed, and its status sub-record + 1 (0
    // none: only hits with a status take one; unit.js _hitStArrays: their
    // statuses (bits), the largest fire and poison damage, a scout's watch
    // key).
    ['hAcc', Int32Array, 1], ['hTouch', Uint8Array, 1], ['hSx', Int32Array, 1],
    // Unit.watchedByTeam (-1 none: the hits kernel sets it with the watch)
    // and, for a scout, the watch its swoop gives (ticks; atkDmg's twin).
    ['wTeam', Int8Array, 1], ['atkWatch', Int32Array, 1]];
// Accessor defaults (the "not indexed / not registered" values).
const SIM_SPATIAL_DEFAULTS = { spTile: -1, spArea: -2, spOwner: -1, spEpoch: 0, spType: -1, vsGen: 0, vsR: -1, vsA: -1, vsP1: -1, vsP2: -1 };
// Worker records: the worker columns are a pool with a record a worker (a
// unit with a workerType: taken when that is set or one of them written,
// given back at its slot's detach), unit.wkIx its index; record 0 holds the
// defaults every other unit reads and is never written (a write takes a
// record first: simUnitWk). The kernels read them by the same names, by
// wkIx. (87 bytes a slot: at 2M units, a third of them workers, ~115 MB.)
// A parked idle worker's work version check (mvFlags 2; see simMoveTryPark):
// its work type, reach (tiles), origin tile, whether its own tile counts too
// (wkTwice 1; 0: the origin is the worker itself; 2: a healer), the version
// its last search failed at and that backoff's end, and the tick of its next
// wake for anything else. A builder's watchdog (worker.js; mvFlags 4 when
// parked): its last sampled position and the tick it last moved
// (Unit._builderLastWatchX/Y, _builderLastMoveTick; NaN / INT_MIN unset).
// Its worker search (wsKind per slot): its resource type, the tick it
// registered, its origin (NaN: where it stands; and until wsOU too), its
// radius, anchor, area steps, need bits, jitter id, current target tile, own
// reserved tile.
const SIM_UNIT_WK_SIDE = [['wkType', Int32Array], ['wkD', Int32Array], ['wkOx', Int32Array], ['wkOy', Int32Array], ['wkTwice', Uint8Array],
    ['wkFail', Int32Array], ['wkUntil', Int32Array], ['wkSched', Int32Array], ['wkWx', Float32Array], ['wkWy', Float32Array], ['wkLmt', Int32Array],
    ['wsCfg', Int8Array], ['wsT', Int32Array], ['wsOU', Int32Array], ['wsOx', Float32Array], ['wsOy', Float32Array], ['wsR', Float32Array],
    ['wsAx', Float32Array], ['wsAy', Float32Array], ['wsAk', Int8Array], ['wsNeed', Int32Array], ['wsJid', Int32Array], ['wsCur', Int32Array], ['wsMy', Int32Array]];
const SIM_WK_DEFAULTS = { wkWx: NaN, wkWy: NaN, wkLmt: -2147483648 };
const _simWkInit = new Function('C', 'i', SIM_UNIT_WK_SIDE.map(([k]) => 'C.' + k + '[i] = ' + (k in SIM_WK_DEFAULTS ? String(SIM_WK_DEFAULTS[k]) : '0') + ';').join(' '));
function _simWkPool(S) { return S.wk || (S.wk = { cap: 0, used: 1, free: [] }); }
// Slot s's worker record (columns c), taken now when it has none: before a
// write. 0 when c is not the live state's (a unit of an old match).
function simUnitWk(c, s) {
    const i = c.wkIx[s];
    if (i > 0) return i;
    const S = _simUnitState;
    return S && S.columns === c ? _simWkTake(S, s) : 0;
}
function _simWkTake(S, s) {
    const W = _simWkPool(S);
    const i = W.free.length ? W.free.pop() : W.used++;
    if (i >= W.cap) _simWkGrow(S, Math.max(4096, Math.ceil((i + 1) * 1.5 / 4096) * 4096));
    _simWkInit(S.columns, i);
    S.columns.wkIx[s] = i;
    return i;
}
// Room for n more worker records at once (a match's start, a restore).
function simUnitWkReserve(n) {
    const S = _simUnitState;
    if (!S || !(n > 0)) return;
    const W = _simWkPool(S), want = Math.ceil((W.used - W.free.length + n) * 1.0625 / 4096) * 4096 + 4096;
    if (want > W.cap) _simWkGrow(S, want);
}
function _simWkGrow(S, cap) {
    const W = _simWkPool(S), C = S.columns;
    // (A job in flight may read the old records: done first, as at a
    // compaction. Growth is rare: by half, and reserved at a start.)
    if (W.cap > 0 && typeof simParallelBackgroundWait === 'function' && typeof SIM_PAR_BG_LANES === 'number') for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) simParallelBackgroundWait(lane);
    if (typeof simParallelBindBatch === 'function') simParallelBindBatch();
    try {
        for (const [k, Type] of SIM_UNIT_WK_SIDE) {
            const a = simHeapArrayAuto(Type, cap, false), old = C[k];
            if (old) a.set(old.subarray(0, Math.min(old.length, W.used)));
            C[k] = a;
            simParallelBind('unit.' + k, a);
        }
    } finally { if (typeof simParallelBindFlush === 'function') simParallelBindFlush(); }
    if (W.cap === 0) _simWkInit(C, 0);
    W.cap = cap;
}
// (At a detach: the record back to the pool.)
function _simWkRelease(S, s) {
    const i = S.columns.wkIx[s];
    if (i > 0) { S.columns.wkIx[s] = 0; _simWkPool(S).free.push(i); }
}

// Status records (SIM_UNIT_ST_SIDE). The pool's words (st.hdr, in the heap: the kernels take and give back records with
// atomics): [0] records on the free stack (st.free), [1] the next never used (record 0 is the zeros'), [2] records, [3] takes
// that found no room (none expected: room for the most a helper phase can take is made before it, simUnitStReserve).
// A phase either takes records (the hits, the movement kernel's floor traps, this thread) or gives them back (the status
// pre-pass), never both, so the free stack needs no more than one atomic word.
function _simStPool(S) { return S.st || (S.st = { cap: 0, hdr: null, free: null, gen: 0 }); }
// Slot s's status record (columns c), taken now when it has none: before a
// write of anything but 0. 0 when c is not the live state's.
function simUnitSt(c, s) {
    const r = c.stIx[s];
    if (r > 0) return r;
    const S = _simUnitState;
    return S && S.columns === c ? _simStTake(S, s) : 0;
}
function _simStTake(S, s) {
    const T = _simStPool(S);
    if (!(T.cap > 0) || _simStRoom(T) < 1) _simStGrow(S, _simStNextCap(T, 1));
    const H = T.hdr, r = H[0] > 0 ? T.free[--H[0]] : H[1]++;
    S.columns.stIx[s] = r;
    return r;
}
function _simStRoom(T) { return T.cap - T.hdr[1] + T.hdr[0]; }
function _simStNextCap(T, n) { const used = T.hdr ? T.hdr[1] - T.hdr[0] : 1; return Math.max(4096, Math.ceil((used + n) * 1.5 / 4096) * 4096); }
// Room for n more records (before a phase whose kernels may take up to that many on the helpers, a restore).
function simUnitStReserve(n) {
    const S = _simUnitState;
    if (!S) return;
    const T = _simStPool(S);
    simUnitStSettle();
    if (!(T.cap > 0) || _simStRoom(T) < n) _simStGrow(S, _simStNextCap(T, n));
}
// After a phase whose kernels took records: a take that found no room (never expected) reported, the next-record word
// brought back within the pool.
function simUnitStSettle() {
    const S = _simUnitState, T = S && S.st;
    if (!T || !T.hdr) return;
    const H = T.hdr;
    if (H[1] > T.cap) H[1] = T.cap;
    if (H[3] > 0) { console.warn('status records: ' + H[3] + ' takes found the pool full (a floor trap fell back to the main thread)'); H[3] = 0; }
}
function _simStGrow(S, cap) {
    const T = _simStPool(S), C = S.columns;
    if (T.cap > 0 && typeof simParallelBackgroundWait === 'function' && typeof SIM_PAR_BG_LANES === 'number') for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) simParallelBackgroundWait(lane);
    if (typeof simParallelBindBatch === 'function') simParallelBindBatch();
    try {
        if (!T.hdr) { T.hdr = simHeapArrayAuto(Int32Array, 8); T.hdr[1] = 1; simParallelBind('st.hdr', T.hdr); }
        const used = Math.min(T.hdr[1], T.cap);
        for (const [k, Type] of SIM_UNIT_ST_SIDE) {
            const a = simHeapArrayAuto(Type, cap), old = C[k];
            if (old && T.cap > 0) a.set(old.subarray(0, Math.min(old.length, used)));
            C[k] = a;
            simParallelBind('unit.' + k, a);
        }
        const free = simHeapArrayAuto(Int32Array, cap, false);
        if (T.free) free.set(T.free.subarray(0, T.hdr[0]));
        T.free = free;
        simParallelBind('st.free', free);
    } finally { if (typeof simParallelBindFlush === 'function') simParallelBindFlush(); }
    T.cap = cap; T.hdr[2] = cap; T.gen++;
}
const _simStZero = new Function('C', 'r', SIM_UNIT_ST_SIDE.map(([k]) => 'C.' + k + '[r] = 0;').join(' '));
// (At a detach, a slot's start: the record zeroed, back to the pool.)
function _simStRelease(S, s) {
    const C = S.columns, r = C.stIx[s];
    if (!(r > 0)) return;
    C.stIx[s] = 0;
    _simStZero(C, r);
    const T = S.st;
    T.free[T.hdr[0]++] = r;
}
// Every unit's damage not reported yet dropped (a resync: statusDotAccReset).
function simUnitStDropPending() {
    const S = _simUnitState, T = S && S.st;
    if (T && T.hdr) S.columns.stAc.fill(0, 0, Math.min(T.hdr[1], T.cap));
}
// Records in use (memory stats, tests).
function simUnitStUsed() { const S = _simUnitState, T = S && S.st; return T && T.hdr ? Math.min(T.hdr[1], T.cap) - 1 - T.hdr[0] : 0; }
// The unit's other fields, read by JavaScript only (no kernel): columns
// beside the wasm ones, outside the wasm heap, an entry a slot, behind its
// accessors (unit.js; ENTITY_TABLES_PLAN.md T1: a unit object holds only its
// slot). Kinds: 'b' a boolean (Uint8), 'i' Int32 (ticks, stamps, versions:
// whole numbers), 'f' Float32, 'd' Float64, 'u' Float32 with undefined as
// NaN, 'r' any value (an array as long as the slots, as the object
// fields'). [name, kind, default, in the snapshot].
const SIM_UNIT_JS_FIELDS = [
    ['_removedNow', 'b', false, true], ['isFlying', 'b', false, true],
    ['_fpTile', 'i', -1, true], ['_fpIdx', 'i', -1, true], ['_fpVer', 'i', -1, true], ['_routeSegEnd', 'i', -1, true], ['_navReady', 'i', 0, true],
    ['_awaitGroupPath', 'i', 0, true], ['_pendingDueStamp', 'i', -1, true], ['_okTile', 'i', -1, true], ['_okVer', 'i', 0, true], ['_okNodeTile', 'i', -1, true],
    ['_okNodeVer', 'i', 0, true], ['_statsVer', 'i', -1, true], ['_damageFlashStart', 'i', 0, true],
    // (Its frame slot: sim_frame.js _simRenderSlotOf; every unit has one.)
    ['_rslot', 'i', -1, false],
    ['_thingStatsRefreshStamp', 'i', 0, true], ['_effectiveStatsStamp', 'i', 0, true], ['_idleFailVer', 'i', -1, true], ['_idleFailUntil', 'i', 0, true],
    ['_damageFlashUntil', 'i', 0, true], ['_damageFlashStrength', 'f', -0, true], ['maxEnergy', 'u', undefined, true],
    ['unitType', 'r', undefined, true], ['preComputedBase', 'r', null, true], ['basePreComputed', 'r', null, true], ['_pce', 'r', null, false], ['_pc', 'r', null, false],
    ['_fpPath', 'r', null, true], ['attackTarget', 'r', null, true], ['_damageFlashColor', 'r', '', true],
    // (Backing fields of accessors with their own logic: unit.js.)
    ['_path', 'r', null, false], ['_ws', 'r', undefined, false], ['_wnr', 'r', undefined, false], 
    ['_pfa', 'r', undefined, false], ['_ppt', 'r', undefined, false]];
const _SIM_JS_TYPED = { b: Uint8Array, i: Int32Array, f: Float32Array, d: Float64Array, u: Float32Array };
// Path/failure caches are JS-only and usually unset in large armies. Keep
// their default implicit; allocating fourteen dense Int32 columns costs
// 224 MB at four million slots before a single path has used them.
const SIM_UNIT_SPARSE_JS_FIELDS=new Set(['_fpTile','_fpIdx','_fpVer','_routeSegEnd','_navReady','_awaitGroupPath',
    '_pendingDueStamp','_okTile','_okVer','_okNodeTile','_okNodeVer','_idleFailVer','_idleFailUntil','_effectiveStatsStamp']);
class SimSparseIntColumn {
    constructor(length,def){this.length=length;this.def=def|0;this.pages=new Array(Math.ceil(length/1024));this.counts=new Uint16Array(this.pages.length);this.activePages=0;}
    get(s){if(!Number.isInteger(s)||s<0||s>=this.length)return undefined;const p=this.pages[s>>>10];return p?p[s&1023]:this.def;}
    set(s,value){
        if(!Number.isInteger(s)||s<0||s>=this.length)return;
        const v=value|0,i=s>>>10,j=s&1023;let p=this.pages[i];
        if(!p){if(v===this.def)return;p=new Int32Array(1024);if(this.def)p.fill(this.def);this.pages[i]=p;this.activePages++;}
        const old=p[j];if(old===v)return;
        if(old===this.def)this.counts[i]++;else if(v===this.def)this.counts[i]--;
        p[j]=v;
        if(!this.counts[i]){this.pages[i]=undefined;this.activePages--;}
    }
    clear(s){this.set(s,this.def);}
    get byteLength(){return this.activePages*4096+this.counts.byteLength;}
    get populated(){let n=0;for(const count of this.counts)n+=count;return n;}
    copyFrom(source,start,count,dest){
        const stop=Math.min(source.length,start+count);
        while(start<stop){
            const end=Math.min(stop,(Math.floor(start/1024)+1)*1024);
            const page=source instanceof SimSparseIntColumn?source.pages[start>>>10]:source;
            if(page)for(let s=start;s<end;s++){const v=page[source instanceof SimSparseIntColumn?s&1023:s];if(v!==this.def)this.set(dest+s-start,v);}
            dest+=end-start;start=end;
        }
    }
}
function _simSparseIntGrow(old,cap,def,used){const a=new SimSparseIntColumn(cap,def);if(old)a.copyFrom(old,0,Math.min(used,cap),0);return a;}
function _simSparseIntCopy(old,cap,def,runs){const a=new SimSparseIntColumn(cap,def);for(let j=0;j<runs.length;j+=3)a.copyFrom(old,runs[j+1],runs[j+2],runs[j]);return a;}
const _simJsName = (k, kind) => (kind === 'r' ? 'jr_' : 'j_') + k;
// (Stored values: booleans 1/0, undefined NaN for 'u'.)
const _simJsDefault = (kind, def) => kind === 'b' ? (def ? 1 : 0) : kind === 'u' ? (def === undefined ? NaN : def) : def;
// Slot s's fields at their defaults (straight-line, as _simSlotZeroFn).
const _simJsDefaults = new Function('C', 's', SIM_UNIT_JS_FIELDS.map(([k, kind, def]) => kind === 'r'||SIM_UNIT_SPARSE_JS_FIELDS.has(k) ? 'C.' + _simJsName(k, kind) + '.clear(s);' : 'C.' + _simJsName(k, kind) + '[s] = ' + (Object.is(_simJsDefault(kind, def), -0) ? '-0' : String(_simJsDefault(kind, def))) + ';').join(' '));
// Reference fields let go (a detach: the slot's next unit starts at the
// defaults anyway; the references would keep paths and targets alive).
const _simJsRelease = new Function('C', 's', SIM_UNIT_JS_FIELDS.filter(e => e[1] === 'r'||SIM_UNIT_SPARSE_JS_FIELDS.has(e[0])).map(([k,kind]) => 'C.'+_simJsName(k,kind)+'.clear(s);').join(' '));
const SIM_UNIT_JS_SNAPSHOT_KEYS = SIM_UNIT_JS_FIELDS.filter(e => e[3]).map(e => e[0]);
// Movement columns that are state (a snapshot's, behind accessors: unit.js).
const SIM_UNIT_MOVE_SNAPSHOT_KEYS = ['atkL', 'wtcL'];
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
    // (Columns allocated ahead: never bound, given back.)
    _simUnitPrepFree(_simUnitState);
    _simUnitState = null;
    for (const k of SIM_UNIT_COLUMNS) simParallelBind('unit.' + k, null);
}

// The columns object has one fixed shape, every column declared up front by
// name: built by adding computed keys one by one, V8 turned it into a
// dictionary, and every unit accessor (x, y, owner...) did a hash lookup.
let _SimUnitColumns = null;
function _simUnitColumnsObject() {
    if (!_SimUnitColumns) {
        const names = [...SIM_UNIT_COLUMNS, ...SIM_MOVE_COLUMNS.map(c => c[0]), ...SIM_UNIT_WK_SIDE.map(c => c[0]), ...SIM_UNIT_ST_SIDE.map(c => c[0]), ...SIM_UNIT_JS_FIELDS.map(e => _simJsName(e[0], e[1])), 'sepKey', 'mvNodes'];
        _SimUnitColumns = new Function(names.map(n => 'this.' + n + ' = null;').join(' ') + ' ' + SIM_UNIT_OBJ_FIELDS.map(k => 'this.oc_' + k + ' = [];').join(' '));
    }
    return new _SimUnitColumns();
}

// Slots released this tick become free for new units (spatialIndexRebuild,
// at the start of a tick).
function simUnitStateReleaseFreed() {
    const S = _simUnitState;
    if (!S || !S.freeLater || !S.freeLater.length) return;
    const sl = S.sl;
    for (const s of S.freeLater) _simSlabFree(sl, s);
    S.freeLater.length = 0;
}

// The columns live in the wasm heap (simHeapArray: the Rust kernels read
// them in place). Old unit objects keep their generation's columns object
// (a whole-world replacement, a compaction): its arrays go back to the
// heap only once nothing reaches that object (_simUnitColumnsGone), never
// while a stale unit could still read or write them.
const _simUnitColumnsGone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(h => { if (SIM_HEAP_GC_FREE & 1) for (const a of h.arrays) simHeapFree(a); }) : null;
function _simUnitColumnsHeld(S) {
    if (!S.held) { S.held = { arrays: [] }; if (_simUnitColumnsGone) _simUnitColumnsGone.register(S.columns, S.held); }
    const list = S.held.arrays;
    list.length = 0;
    for (const k of SIM_UNIT_COLUMNS) list.push(S.columns[k]);
    for (const [k] of SIM_MOVE_COLUMNS) list.push(S.columns[k]);
    list.push(S.sepKey, S.sepLayer);
}
function _simUnitStateNew() {
    return _simUnitState = { cap: 0, owners: [], sl: _simSlabNew(), columns: _simUnitColumnsObject(), stamp: null, epoch: 0, unitsRef: null, held: null };
}
// Room for n more units in one step (before many are made at once: the
// match's starting units, a restore): growing by half each time kept every
// size's columns until the heap could reuse them (2-3 times the last).
// `room`: as many as that if the wasm heap holds them (a population's
// reservation, simUnitPopulationSlots), else n.
function simUnitStateReserve(n, room = n) {
    // (Nothing to make: no state made either; one is always made with its
    // columns, simUnitStateAllocate.)
    if (!(n > 0) && !(room > 0)) return;
    const S = _simUnitState || _simUnitStateNew();
    // (With the slabs' allowed holes, up to 1 in 2^SIM_SLAB_SLACK_SHIFT: units
    // fill 64-slot slabs block by block, and without that room a starting army
    // a few percent past the count grew every column by 1/8, the old and new
    // copies held at once: 4.7 GB at 4M units, more than a 32-bit heap.)
    const slots = k => { const more = Math.max(0, k - S.sl.nfree); return Math.max(1024, Math.ceil((S.owners.length + more + (more >> SIM_SLAB_SLACK_SHIFT)) / 4096) * 4096); };
    const need = slots(Math.max(0, n | 0)), want = Math.max(need, slots(Math.max(0, room | 0)));
    // (Columns outside the heap, an earlier allocation's failure: made
    // again, in the heap, when it has room now.)
    if (want > S.cap || _simUnitColumnsOutside(S)) _simUnitStateGrow(S, want, need);
    // (Status records for a sixteenth of them: a battle's statuses then grow
    // the pool a few times, not a dozen, each a wait for the background jobs.)
    if (S.cap > 0) simUnitStReserve(Math.ceil(Math.max(0, n | 0) / 16));
}
// Whether any of the units' columns lies outside the wasm heap (the heap
// was full when it was made).
function _simUnitColumnsOutside(S) {
    if (!S || !S.cap || typeof simHeapHas !== 'function') return false;
    for (const k of SIM_UNIT_COLUMNS) if (!simHeapHas(S.columns[k])) return true;
    for (const [k] of SIM_MOVE_COLUMNS) if (!simHeapHas(S.columns[k])) return true;
    return !simHeapHas(S.sepKey) || !simHeapHas(S.sepLayer);
}
// The largest of cap and minCap (4096-slot steps) whose columns the heap
// holds now (grown as needed); minCap when none does.
// (With room for the work arrays sized by the slots too, made again at the
// next tick (occupancy records, index scratch, flow tables: ~230 B a slot at
// 4M): columns alone left them none in a full heap, and they were made
// outside it, where no kernel reads them (heap-full-reserve, tick 39).)
const SIM_UNIT_WORK_BYTES_PER_SLOT = 256;
function _simUnitCapThatFits(cap, minCap) {
    if (cap <= minCap || typeof simHeapRoom !== 'function') return Math.max(cap, minCap);
    const per = (_simUnitBytesPerSlot() + SIM_UNIT_WORK_BYTES_PER_SLOT) * 1.01;
    for (let c = cap; c > minCap; c = Math.max(minCap, Math.floor(c / 2 / 4096) * 4096)) if (simHeapRoom(per * c)) return c;
    return minCap;
}
// Slots by place. The movement jobs take the units of one 16x16-tile block
// together and read their columns by slot, hundreds of columns' lines: slots
// that follow space share those lines, slots in spawn order (thousands of
// barracks, interleaved) share none (slots shuffled: tick +54%, stage 2 +51%;
// sorted by Morton: -8%, -21%). Slots come in slabs of SIM_SLAB; a unit takes a
// free slot of the slab its block is filling (a block is where it is made),
// else a hole of the block's own slabs, else an empty slab or a new one. Where
// more than 1/16 of the slots lie free, the nearest hole instead (memory:
// every slot is ~580 bytes). Which slot a unit gets decides nothing (slots are
// local to each peer: a restore lays them out anew).
const SIM_SLAB = 64, SIM_SLAB_KEY_TILES = 16, SIM_SLAB_SLACK_SHIFT = 4, SIM_SLAB_SLACK_MIN = 2048;
function _simSlabKeys(sl) {
    sl.kw = Math.max(1, Math.ceil(GRID_W / SIM_SLAB_KEY_TILES)); sl.kh = Math.max(1, Math.ceil(GRID_H / SIM_SLAB_KEY_TILES)); sl.nk = sl.kw * sl.kh + 1;
    sl.gw = GRID_W; sl.gh = GRID_H;
    sl.cur = new Int32Array(sl.nk).fill(-1); sl.holes = new Array(sl.nk).fill(null);
}
function _simSlabNew() {
    const sl = { kw: 0, kh: 0, nk: 0, gw: 0, gh: 0, nfree: 0, slabs: 0, pushes: 0, cur: null, holes: null, any: [], empty: [], bits: new Uint32Array(0), used: new Uint32Array(0), sfree: new Uint8Array(0), home: new Int32Array(0), want: -1, plan0: -1, layout: 0 };
    _simSlabKeys(sl);
    return sl;
}
// The block a position is in (the last key: no position, a decoded shell).
function _simSlabKey(sl, x, y) {
    if (!(x >= 0) || !(y >= 0)) return sl.nk - 1;
    const kx = Math.min(sl.kw - 1, (x / (TILE * SIM_SLAB_KEY_TILES)) | 0), ky = Math.min(sl.kh - 1, (y / (TILE * SIM_SLAB_KEY_TILES)) | 0);
    return ky * sl.kw + kx;
}
function _simSlabReserve(sl, slabs) {
    if (sl.sfree.length >= slabs) return;
    const n = Math.max(slabs, Math.ceil(sl.sfree.length * 1.5), 64);
    const sfree = new Uint8Array(n), home = new Int32Array(n).fill(-1), bits = new Uint32Array(n * 2), used = new Uint32Array(n * 2);
    sfree.set(sl.sfree); home.set(sl.home); bits.set(sl.bits); used.set(sl.used);
    sl.sfree = sfree; sl.home = home; sl.bits = bits; sl.used = used;
}
// A new slab (its 64 slots free, never used) at the end of the owners.
function _simSlabFresh(S, sl) {
    const slab = sl.slabs, slots = (slab + 1) * SIM_SLAB;
    if (slots > S.cap) _simUnitStateGrow(S, _simUnitNextCap(S.cap), Math.ceil(slots / 4096) * 4096);
    sl.slabs++;
    _simSlabReserve(sl, sl.slabs);
    sl.bits[slab * 2] = 0xFFFFFFFF; sl.bits[slab * 2 + 1] = 0xFFFFFFFF; sl.sfree[slab] = SIM_SLAB; sl.home[slab] = -1; sl.nfree += SIM_SLAB;
    const o = S.owners;
    for (let i = 0; i < SIM_SLAB; i++) o.push(null);
    return slab;
}
// The lowest free slot of a slab.
function _simSlabTake(sl, slab) {
    const w = slab * 2;
    let b = sl.bits[w], s;
    if (b !== 0) { sl.bits[w] = b & (b - 1); s = slab * SIM_SLAB + 31 - Math.clz32(b & -b); }
    else { b = sl.bits[w + 1]; sl.bits[w + 1] = b & (b - 1); s = slab * SIM_SLAB + 63 - Math.clz32(b & -b); }
    sl.sfree[slab]--; sl.nfree--;
    return s;
}
function _simSlabFree(sl, s) {
    const slab = s >> 6;
    sl.bits[s >> 5] |= 1 << (s & 31); sl.nfree++;
    const f = ++sl.sfree[slab];
    if (f === 1) {
        const h = sl.home[slab];
        if (h >= 0) (sl.holes[h] || (sl.holes[h] = [])).push(slab);
        sl.any.push(slab);
    } else if (f === SIM_SLAB) sl.empty.push(slab);
    // (The lists keep entries that went stale: made anew now and then.)
    if (++sl.pushes > 4 * sl.slabs + 4096) _simSlabRelist(sl);
}
// The lists from the slabs' counts.
function _simSlabRelist(sl) {
    sl.pushes = 0; sl.any.length = 0; sl.empty.length = 0;
    for (const L of sl.holes) if (L !== null) L.length = 0;
    for (let slab = 0; slab < sl.slabs; slab++) {
        const f = sl.sfree[slab];
        if (f === 0) continue;
        if (f === SIM_SLAB) { sl.empty.push(slab); continue; }
        const h = sl.home[slab];
        if (h >= 0) (sl.holes[h] || (sl.holes[h] = [])).push(slab);
        sl.any.push(slab);
    }
}
// A hole of a neighbouring block's slabs, else of any slab; -1 when none.
function _simSlabNearHole(sl, key) {
    if (key < sl.nk - 1) {
        const kx = key % sl.kw, ky = (key - kx) / sl.kw;
        for (let r = 1; r <= 2; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            if ((dx < 0 ? -dx : dx) !== r && (dy < 0 ? -dy : dy) !== r) continue;
            const x = kx + dx, y = ky + dy;
            if (x < 0 || y < 0 || x >= sl.kw || y >= sl.kh) continue;
            const k2 = y * sl.kw + x, L = sl.holes[k2];
            if (L === null) continue;
            while (L.length > 0) { const slab = L[L.length - 1]; if (sl.sfree[slab] > 0 && sl.home[slab] === k2) return _simSlabTake(sl, slab); L.pop(); }
        }
    }
    const A = sl.any;
    while (A.length > 0) { const slab = A[A.length - 1]; if (sl.sfree[slab] > 0) return _simSlabTake(sl, slab); A.pop(); }
    return -1;
}
function _simSlabAlloc(S, sl, key) {
    let slab = sl.cur[key];
    if (slab >= 0 && sl.sfree[slab] > 0 && sl.home[slab] === key) return _simSlabTake(sl, slab);
    const H = sl.holes[key];
    if (H !== null) while (H.length > 0) { slab = H.pop(); if (sl.sfree[slab] > 0 && sl.home[slab] === key) { sl.cur[key] = slab; return _simSlabTake(sl, slab); } }
    if (sl.nfree > Math.max(SIM_SLAB_SLACK_MIN, S.owners.length >> SIM_SLAB_SLACK_SHIFT)) { const s = _simSlabNearHole(sl, key); if (s >= 0) return s; }
    const E = sl.empty;
    while (E.length > 0) { slab = E.pop(); if (sl.sfree[slab] === SIM_SLAB) { sl.home[slab] = key; sl.cur[key] = slab; return _simSlabTake(sl, slab); } }
    slab = _simSlabFresh(S, sl); sl.home[slab] = key; sl.cur[key] = slab;
    return _simSlabTake(sl, slab);
}
// A planned slot (simUnitStateWantSlot): that slot itself; -1 when it is taken.
function _simSlabClaim(S, sl, s, key) {
    const slab = s >> 6;
    while (sl.slabs <= slab) _simSlabFresh(S, sl);
    if ((sl.bits[s >> 5] & (1 << (s & 31))) === 0) return -1;
    sl.bits[s >> 5] &= ~(1 << (s & 31)); sl.sfree[slab]--; sl.nfree--;
    if (sl.home[slab] < 0) sl.home[slab] = key;
    return s;
}
// The next unit made takes slot s (a bulk creation that planned its layout);
// simUnitStatePlanBegin/End around the creations.
function simUnitStateWantSlot(s) { const S = _simUnitState || _simUnitStateNew(); S.sl.want = s; }
function simUnitStatePlanBegin() { const S = _simUnitState || _simUnitStateNew(); S.sl.plan0 = S.sl.slabs; S.sl.want = -1; }
// The slabs the plan opened but left with free slots take their place in the lists.
function simUnitStatePlanEnd() {
    const S = _simUnitState; if (!S) return;
    const sl = S.sl; sl.want = -1;
    if (sl.plan0 < 0) return;
    sl.plan0 = -1; sl.layout = 1;
    _simSlabRelist(sl);
}
// Slot keys of positions (pixels) for a plan: stable by block, so units made
// together keep their order within a block. Returns the slot of each position.
function simUnitStatePlanSlots(xs, ys, n) {
    const S = _simUnitState || _simUnitStateNew(), sl = S.sl, nk = sl.nk;
    const key = new Int32Array(n), count = new Int32Array(nk + 1);
    for (let i = 0; i < n; i++) { const k = _simSlabKey(sl, xs[i], ys[i]); key[i] = k; count[k + 1]++; }
    for (let k = 0; k < nk; k++) count[k + 1] += count[k];
    const slot = new Int32Array(n), base = S.owners.length;
    for (let i = 0; i < n; i++) slot[i] = base + count[key[i]]++;
    return slot;
}
// The allocator's books against the owners (tests): free bits against the slots'
// units, each slab's count and the total against the bits.
function simUnitSlabAudit() {
    const S = _simUnitState;
    if (!S) return null;
    const sl = S.sl, pending = new Set(S.freeLater || []);
    let freeBits = 0, wrongSlots = 0, wrongCounts = 0, unmarkedUsed = 0, listed = 0;
    const wrongLength = S.owners.length !== sl.slabs * SIM_SLAB;
    for (let slab = 0; slab < sl.slabs; slab++) {
        let f = 0;
        for (let i = 0; i < SIM_SLAB; i++) {
            const s = slab * SIM_SLAB + i, free = (sl.bits[s >> 5] & (1 << (s & 31))) !== 0;
            if (free) { f++; if (S.owners[s]) wrongSlots++; }
            else if (!S.owners[s] && !pending.has(s)) wrongSlots++;
            if (S.owners[s] && (sl.used[s >> 5] & (1 << (s & 31))) === 0) unmarkedUsed++;
        }
        if (f !== sl.sfree[slab]) wrongCounts++;
        freeBits += f;
    }
    // (Every slab with free slots that is a block's own can be found from its list or is its block's current one.)
    for (let slab = 0; slab < sl.slabs; slab++) {
        const f = sl.sfree[slab], h = sl.home[slab];
        if (f === 0 || f === SIM_SLAB || h < 0) continue;
        const L = sl.holes[h];
        if (!(sl.cur[h] === slab || (L !== null && L.includes(slab)))) listed++;
    }
    return { slots: S.owners.length, slabs: sl.slabs, free: sl.nfree, freeBits, wrongLength, wrongSlots, wrongCounts, unmarkedUsed, unlistedPartial: listed,
        ok: !wrongLength && wrongSlots === 0 && wrongCounts === 0 && unmarkedUsed === 0 && freeBits === sl.nfree };
}
// The allocator made anew for units in slots 0..ns-1 (a compaction): every slab
// full but the last, a slab's block that of its first unit.
function _simSlabFromLive(S, ns, sorted = false) {
    const sl = S.sl = _simSlabNew(), slabs = Math.ceil(ns / SIM_SLAB), o = S.owners;
    if (slabs * SIM_SLAB > S.cap) _simUnitStateGrow(S, _simUnitNextCap(S.cap), Math.ceil(slabs * SIM_SLAB / 4096) * 4096);
    while (o.length < slabs * SIM_SLAB) o.push(null);
    _simSlabReserve(sl, slabs);
    sl.slabs = slabs;
    for (let s = 0; s < ns; s++) sl.used[s >> 5] |= 1 << (s & 31);
    for (let slab = 0; slab < slabs; slab++) {
        const a = slab * SIM_SLAB, live = Math.min(SIM_SLAB, ns - a);
        for (let s = a + live; s < a + SIM_SLAB; s++) sl.bits[s >> 5] |= 1 << (s & 31);
        sl.sfree[slab] = SIM_SLAB - live; sl.nfree += SIM_SLAB - live;
        const u = o[a];
        sl.home[slab] = u ? _simSlabKey(sl, u.x, u.y) : -1;
    }
    sl.layout = sorted ? 1 : 0;
    _simSlabRelist(sl);
}
function simUnitStateAllocate(u, x, y) {
    let S = _simUnitState || _simUnitStateNew();
    const sl = S.sl;
    if (sl.gw !== GRID_W || sl.gh !== GRID_H) { _simSlabKeys(sl); for (let i = 0; i < sl.slabs; i++) sl.home[i] = -1; _simSlabRelist(sl); }
    const key = _simSlabKey(sl, x, y);
    let s = -1;
    if (sl.want >= 0) { s = _simSlabClaim(S, sl, sl.want, key); sl.want = -1; }
    if (s < 0) { s = _simSlabAlloc(S, sl, key); sl.layout = 0; }
    // (Never used: its columns are as a new slot's, nothing to clear.)
    const reused = (sl.used[s >> 5] & (1 << (s & 31))) !== 0;
    sl.used[s >> 5] |= 1 << (s & 31);
    // (Grown by half, in whole 4096-slot steps: doubling left up to half of
    // ~850 bytes a slot unused, 1M slots for 600k units.)
    if (s >= S.cap) _simUnitStateGrow(S, _simUnitNextCap(S.cap), Math.ceil((s + 1) / 4096) * 4096);
    // A slot that held a unit before: every column zeroed, as a fresh slot's
    // (its last unit's kernel state (committed steps, steady windows, flags,
    // speeds) must not reach the new one: which slot a unit gets depends on
    // the peer's history, a restore's above all, so a leftover there made
    // peers diverge).
    if (reused) { _simStRelease(S, s); (_simSlotZero || (_simSlotZero = _simSlotZeroFn()))(S.columns, s); S.sepLayer[s] = 0; }
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
// References use pages only where values differ from their column default.
// Most role/path/target fields are unset in a large army. Empty pages cost
// one directory slot, and clearing their last value releases the page.
class SimRefColumn {
    constructor(length, def = undefined) { this.length = length; this.def = def; this.pages = new Array(Math.ceil(length / 1024)); }
    get(s) { const p = this.pages[s >>> 10]; return p ? p[s & 1023] : this.def; }
    set(s, v) {
        const k = s >>> 10, i = s & 1023;
        let p = this.pages[k];
        if (!p) {
            if (Object.is(v, this.def)) return this.def;
            p = new Array(1024).fill(this.def); p.used = 0; this.pages[k] = p;
        }
        const old = p[i];
        if (Object.is(old, v)) return old;
        if (Object.is(old, this.def)) p.used++;
        if (Object.is(v, this.def)) p.used--;
        p[i] = v;
        if (p.used === 0) this.pages[k] = undefined;
        return old;
    }
    clear(s) { this.set(s, this.def); }
    reserve(cap) { if (cap > this.length) { this.length = cap; this.pages.length = Math.ceil(cap / 1024); } }
}
// Small handles for type names and shared precomputed tables. Research and
// level combinations create a few shared objects, not one object per unit.
// The common case needs one byte per slot; widen only when the table grows.
class SimSharedColumn extends SimRefColumn {
    constructor(length, def = undefined, pool = null) {
        super(length, def);
        const negativeZero = {};
        this.pool = pool || { values: [def], ids: new Map([[Object.is(def,-0) ? negativeZero : def, 0]]), negativeZero };
        const n = this.pool.values.length;
        this.data = new (n > 65536 ? Uint32Array : n > 256 ? Uint16Array : Uint8Array)(length);
    }
    get(s) { return this.pool.values[this.data[s]]; }
    set(s, v) {
        const P = this.pool, old = P.values[this.data[s]];
        if (Object.is(old, v)) return old;
        const key = Object.is(v, -0) ? P.negativeZero : v;
        let id = P.ids.get(key);
        if (id === undefined) { id = P.values.length; P.values.push(v); P.ids.set(key, id); }
        if (id > (this.data.BYTES_PER_ELEMENT === 1 ? 255 : this.data.BYTES_PER_ELEMENT === 2 ? 65535 : 4294967295)) {
            const a = new (id > 65535 ? Uint32Array : Uint16Array)(this.length); a.set(this.data); this.data = a;
        }
        this.data[s] = id;
        return old;
    }
    clear(s) { if (this.data[s] !== 0) this.data[s] = 0; }
    reserve(cap) {
        if (cap <= this.length) return;
        const a = new this.data.constructor(cap); a.set(this.data); this.data = a;
        this.length = cap;
    }
}
const SIM_SHARED_REF_FIELDS = new Set(['unitType','preComputedBase','basePreComputed','_pce','_pc','_damageFlashColor','workerTargetType']);
function _simRefGrow(a, cap, def = undefined, shared = false) {
    if (a instanceof SimRefColumn) { a.reserve(cap); return a; }
    const b = shared ? new SimSharedColumn(cap, def) : new SimRefColumn(cap, def);
    if (a) for (let i = 0; i < a.length; i++) b.set(i, a[i]);
    return b;
}
function _simRefCopy(a, cap, runs) {
    if (a instanceof SimSharedColumn) {
        const b = new SimSharedColumn(cap, a.def, a.pool);
        for (let r = 0; r < runs.length; r += 3) b.data.set(a.data.subarray(runs[r + 1], runs[r + 1] + runs[r + 2]), runs[r]);
        return b;
    }
    const b = new SimRefColumn(cap, a.def);
    if (!a.pages.some(Boolean)) return b;
    for (let r = 0; r < runs.length; r += 3) for (let to = runs[r], from = runs[r + 1], e = from + runs[r + 2]; from < e; to++, from++) b.set(to, a.get(from));
    return b;
}
// (By half; past a million slots by an eighth: a growth makes a whole new set of columns beside the old, and by half that was
// 1.9 GB beside 1.2 GB at 2.4M slots.)
function _simUnitNextCap(cap) { return Math.max(1024, Math.ceil(cap * (cap >= 1048576 ? 1.125 : 1.5) / 4096) * 4096); }
// The slots a match's population needs, reserved at its start, at a whole
// restore and at a compaction: every player's configured maximum
// population, and room for units that died this tick (their slots come back
// the next). Growth is then a fallback. (Reserved columns cost address space,
// not memory: the kernels touch the slots in use, and the heap's memory is
// committed at its first write. Growing by half held old and new columns at
// once, and each growth was a spike.) At most SIM_UNIT_RESERVE_BYTES of
// columns (~800k slots): the lobby's default is 200k a player, and eight
// players' 1.6M slots would hold a quarter of the wasm heap's 4 GB of
// address space (and the system's commit charge) in any match; past it, the
// growth, allocated ahead.
const SIM_UNIT_RESERVE_BYTES = 512 << 20;
let _simUnitBytesPerSlotCache = 0;
function _simUnitBytesPerSlot() {
    if (!_simUnitBytesPerSlotCache) {
        let n = 5;
        for (const k of SIM_UNIT_COLUMNS) n += _simUnitColumnType(k).BYTES_PER_ELEMENT;
        for (const [, Type, per] of SIM_MOVE_COLUMNS) n += Type.BYTES_PER_ELEMENT * per;
        _simUnitBytesPerSlotCache = n;
    }
    return _simUnitBytesPerSlotCache;
}
function simUnitPopulationSlots() {
    // (The teams in the match: players holds every lobby slot, 8.)
    const np = typeof activeTeamIds !== 'undefined' && Array.isArray(activeTeamIds) && activeTeamIds.length ? activeTeamIds.length
        : typeof players !== 'undefined' && Array.isArray(players) ? players.length : 0;
    const pop = typeof getConfiguredMaxPop === 'function' ? getConfiguredMaxPop() : 0;
    if (!(np > 0) || !(pop > 0)) return 0;
    const want = pop * np + Math.max(4096, Math.ceil(pop * np / 32));
    // (No more than the map plausibly holds, SIM_UNIT_RESERVE_PER_TILE a
    // tile: a 20x20 map's match reserved ~500 MB of columns for its 200k a
    // player, a commit of the system's memory per match; past that, the
    // growth allocated ahead, as past SIM_UNIT_RESERVE_BYTES.)
    const tiles = typeof GRID_W === 'number' && typeof GRID_H === 'number' && GRID_W > 0 && GRID_H > 0 ? GRID_W * GRID_H : Infinity;
    return Math.min(want, tiles * SIM_UNIT_RESERVE_PER_TILE, Math.floor(SIM_UNIT_RESERVE_BYTES / _simUnitBytesPerSlot()));
}
const SIM_UNIT_RESERVE_PER_TILE = 8;
// Past the reservation (the fallback): the next size's columns allocated
// ahead (simUnitStatePrepareStep, from gameTick: once the slots pass
// SIM_UNIT_PREP_FILL of the capacity, at most SIM_UNIT_PREP_BYTES of them a
// tick), so that a growth only copies and binds (~10 ms at 50k slots; at a
// spawn, mid-tick, it was 55-75 ms: fresh zeroed heap columns, new
// object-field arrays, a message per binding and helper). Memory only: the
// slots and what the units do are the same whenever it happens.
const SIM_UNIT_PREP_FILL = 0.6, SIM_UNIT_PREP_BYTES = 6 << 20;
const SIM_UNIT_PREP_MAX_BYTES = 512 << 20;
let _simUnitPrepSpecs = null;
function _simUnitPrepList() {
    if (!_simUnitPrepSpecs) {
        _simUnitPrepSpecs = [];
        for (const k of SIM_UNIT_COLUMNS) _simUnitPrepSpecs.push([k, _simUnitColumnType(k), 1]);
        for (const [k, Type, per] of SIM_MOVE_COLUMNS) _simUnitPrepSpecs.push([k, Type, per]);
        _simUnitPrepSpecs.push(['sepKey', Uint32Array, 1], ['sepLayer', Uint8Array, 1]);
    }
    return _simUnitPrepSpecs;
}
function _simUnitPrepFreeArrays(P) { for (const k in P.arrays) if (P.arrays[k]) simHeapFree(P.arrays[k]); P.arrays = {}; }
function _simUnitPrepFree(S) {
    if (!S || !S.pre) return;
    _simUnitPrepFreeArrays(S.pre);
    S.pre = null;
}
function simUnitStatePrepareStep() {
    const S = _simUnitState;
    if (!S || !S.cap || S.owners.length < S.cap * SIM_UNIT_PREP_FILL) return;
    // (No more than the population can need: every player's cap (the dead not
    // yet collected beyond it grow it at need). The columns already that large: nothing
    // ahead (at 2M units the next size, 1.4 GB, was made ahead each match
    // and filled the wasm heap in ~100 ticks).)
    const np = typeof activeTeamIds !== 'undefined' && Array.isArray(activeTeamIds) && activeTeamIds.length ? activeTeamIds.length : 2;
    const pop = typeof getConfiguredMaxPop === 'function' ? getConfiguredMaxPop() : 0;
    const most = pop > 0 ? Math.ceil(pop * np / 4096) * 4096 : Infinity;
    if (S.cap >= most) return;
    // (Not past SIM_UNIT_PREP_MAX_BYTES of columns: made ahead they are written zero once and held for a growth that may never come,
    // 0.8 GB and growing at 2.3M units; a growth there makes them when it comes.)
    if (_simUnitNextCap(S.cap) * _simUnitBytesPerSlot() > SIM_UNIT_PREP_MAX_BYTES) return;
    const cap = Math.min(_simUnitNextCap(S.cap), most), L = _simUnitPrepList();
    // (The heap had no room for this size: tried again from the next
    // growth's size on, or after SIM_UNIT_PREP_RETRY ticks.)
    if (S.preFail === cap && gameTime < S.preFailAt + SIM_UNIT_PREP_RETRY) return;
    if (S.pre && S.pre.cap !== cap) _simUnitPrepFree(S);
    const P = S.pre || (S.pre = { cap, arrays: {}, next: 0 });
    let bytes = 0;
    for (; P.next < L.length && bytes < SIM_UNIT_PREP_BYTES;) {
        const [k, Type, per] = L[P.next++], a = simHeapArray(Type, cap * per);
        // (Outside the heap (full): none of it kept, the growth makes its
        // own then, which may fit what is free by then.)
        if (typeof simHeapHas === 'function' && !simHeapHas(a)) { _simUnitPrepFree(S); S.preFail = cap; S.preFailAt = gameTime; return; }
        // (Written once now: memory the heap just grew into is committed by
        // the system at its first write.)
        a.fill(0);
        P.arrays[k] = a; bytes += a.byteLength;
    }
}
const SIM_UNIT_PREP_RETRY = 200;
// minCap: the least the columns may hold (the slots needed now); cap, what
// they should when the wasm heap has room (a reservation): every column in
// the heap, or (the heap full even for minCap) as before.
function _simUnitStateGrow(S, cap, minCap = cap) {
    // (The next size allocated ahead, when it is at least this one: taken,
    // the rest made now. Smaller (a reserve for many at once): let go.)
    let P = S.pre;
    if (P && P.cap < cap) { _simUnitPrepFree(S); P = null; }
    if (P) cap = P.cap;
    else cap = _simUnitCapThatFits(cap, minCap);
    S.pre = null;
    const take = (k, Type, n) => { const a = P && P.arrays[k]; if (a) { P.arrays[k] = null; return a; } return simHeapArray(Type, n); };
    // The new arrays, then every column's content copied in one parallel job
    // (simParallelCopyHeap: before any binding, so the helpers take part),
    // then the arrays bound (to the helpers in one message each) and the old
    // ones given back to the heap, see above.
    const fresh = [], copies = [], old = [];
    for (const k of SIM_UNIT_COLUMNS) fresh.push(k, take(k, _simUnitColumnType(k), cap));
    for (const [k, Type, per] of SIM_MOVE_COLUMNS) fresh.push(k, take(k, Type, cap * per));
    const sepKey = take('sepKey', Uint32Array, cap), sepLayer = take('sepLayer', Uint8Array, cap);
    // (Any of them outside the heap, which was full: given back, and the
    // least instead, while that is less.)
    if (cap > minCap && typeof simHeapHas === 'function' && (!simHeapHas(sepKey) || !simHeapHas(sepLayer) || fresh.some((a, i) => i % 2 === 1 && !simHeapHas(a)))) {
        for (let i = 1; i < fresh.length; i += 2) simHeapFree(fresh[i]);
        simHeapFree(sepKey); simHeapFree(sepLayer);
        if (P) _simUnitPrepFreeArrays(P);
        return _simUnitStateGrow(S, minCap, minCap);
    }
    sepKey.fill(SIM_SEP_ABSENT);
    // (The slots in use only: past them every column is as a fresh slot's.)
    const used = S.owners.length, part = (a, per) => a.subarray(0, Math.min(a.length, used * per));
    for (let i = 0; i < fresh.length; i += 2) { const was = S.columns[fresh[i]]; if (was) { copies.push(fresh[i + 1], part(was, was.length / Math.max(1, S.cap))); old.push(was); } }
    if (S.sepKey) { copies.push(sepKey, part(S.sepKey, 1), sepLayer, part(S.sepLayer, 1)); old.push(S.sepKey, S.sepLayer); }
    if (typeof simParallelCopyHeap === 'function') simParallelCopyHeap(copies); else for (let i = 0; i < copies.length; i += 2) copies[i].set(copies[i + 1]);
    if (typeof simParallelBindBatch === 'function') simParallelBindBatch();
    try {
        for (let i = 0; i < fresh.length; i += 2) { S.columns[fresh[i]] = fresh[i + 1]; simParallelBind('unit.' + fresh[i], fresh[i + 1]); }
        // (The object fields' arrays: as long as the columns, see _simRefGrow.)
        for (const k of SIM_UNIT_OBJ_FIELDS) S.columns['oc_' + k] = _simRefGrow(S.columns['oc_' + k], cap, SIM_UNIT_OBJ_DEFAULTS[k], SIM_SHARED_REF_FIELDS.has(k));
        // (The JavaScript fields: typed columns sized with the others, plain
        // memory; references as the object fields'.)
        for (const [k, kind, def] of SIM_UNIT_JS_FIELDS) {
            const nm = _simJsName(k, kind);
            if (kind === 'r') { S.columns[nm] = _simRefGrow(S.columns[nm], cap, def, SIM_SHARED_REF_FIELDS.has(k)); continue; }
            if (SIM_UNIT_SPARSE_JS_FIELDS.has(k)) {S.columns[nm]=_simSparseIntGrow(S.columns[nm],cap,def,used);continue;}
            const was = S.columns[nm], a = new _SIM_JS_TYPED[kind](cap);
            if (was) a.set(was.subarray(0, Math.min(was.length, used, cap)));
            S.columns[nm] = a;
        }
        const stamp = new Uint32Array(cap);
        // (Smaller only when columns outside the heap are made again: see
        // simUnitStateReserve.)
        if (S.stamp) stamp.set(S.stamp.length > cap ? S.stamp.subarray(0, cap) : S.stamp);
        S.stamp = stamp;
        S.sepKey = sepKey; S.sepLayer = sepLayer; S.columns.sepKey = sepKey;
        simParallelBind('unit.sepKey', sepKey); simParallelBind('unit.sepLayer', sepLayer);
        S.cap = cap;
        if (!S.pathPool) { S.pathPool = { next: 0, free: [], cap: 0, held: { array: null } }; S.columns.mvNodes = simHeapArray(Int32Array, 1); S.pathPool.held.array = S.columns.mvNodes; if (_simPathPoolsGone) _simPathPoolsGone.register(S.pathPool, S.pathPool.held); simParallelBind('unit.mvNodes', S.columns.mvNodes); }
        _simUnitColumnsHeld(S);
        for (const a of old) simHeapFree(a);
    } finally { if (typeof simParallelBindFlush === 'function') simParallelBindFlush(); }
    // (The worker records' pool with the first columns: record 0, the
    // defaults, read by every other unit.)
    if (!(_simWkPool(S).cap > 0)) _simWkGrow(S, 4096);
    // (And the status records' pool: record 0, the zeros.)
    if (!(_simStPool(S).cap > 0)) _simStGrow(S, 4096);
}
// Slot s taken by unit u: its defaults, and u's accessors pointed at it.
const _simSlotDesc = { value: null, writable: true };
function _simUnitSlotStart(S, s, u) {
    S.sepKey[s] = SIM_SEP_ABSENT;
    S.columns.mvOn[s] = 0; S.columns.mvOut[s] = 0; S.columns.mvWk[s] = 0; S.columns.dead[s] = 0; S.columns.mvNav[s * SIM_NAV_STRIDE] = -1; S.columns.mvNavLD[s] = -1; S.columns.mvFloor[s] = -1; S.columns.sepMov[s] = 0;
    S.columns.esOk[s] = 0; S.columns.esTaken[s] = 0; S.columns.tmOn[s] = 1; S.columns.lzAcc[s] = typeof u._lzp === 'number' ? u._lzp : 0; S.columns.lzBeam[s] = typeof u._lzb === 'number' ? u._lzb : 0; S.columns.sepCx[s] = 0; S.columns.sepIv[s] = 0; S.columns.sepCv[s] = 0; S.columns.esVer[s] = -1; S.columns.statRow[s] = -1;
    S.columns.fLsX[s] = NaN; S.columns.fLsY[s] = NaN;
    // (No status record; one for its damage not reported yet, a restore's.)
    if (S.columns.stIx[s] > 0) _simStRelease(S, s);
    if (typeof u._dtp === 'number' && u._dtp !== 0) S.columns.stAc[_simStTake(S, s)] = u._dtp;
    // (A worker record for a worker, or a unit carrying a builder's watch.)
    S.columns.wkIx[s] = 0;
    if (u.workerType || typeof u._bwx === 'number' || typeof u._bwy === 'number' || typeof u._bmt === 'number') {
        const w = _simWkTake(S, s);
        if (typeof u._bwx === 'number') S.columns.wkWx[w] = u._bwx;
        if (typeof u._bwy === 'number') S.columns.wkWy[w] = u._bwy;
        if (typeof u._bmt === 'number' && u._bmt === Math.floor(u._bmt)) S.columns.wkLmt[w] = u._bmt;
    }
    for (const k of SIM_UNIT_LEVEL_COLUMNS) S.columns[k][s] = NaN;
    for (const k in SIM_SPATIAL_DEFAULTS) S.columns[k][s] = SIM_SPATIAL_DEFAULTS[k];
    S.owners[s] = u;
    S.columns.mvPath[s] = -1;
    S.columns.live[s] = 1; S.columns.maxE[s] = Number(u.maxEnergy); S.columns.spMvOwn[s] = 0; S.columns.mvBlk[s] = 0; S.columns.mvCD[s] = -1; S.columns.wsKind[s] = 0;
    // (Tick-stamped answers of the slot's last unit are not this one's.)
    S.columns.acqB[s] = 0; S.columns.cmMode[s] = 0; S.columns.cmT[s] = -1; S.columns.cmTId[s] = 0; S.columns.isWk[s] = u.workerType ? 1 : 0;
    S.columns.rkF[s] = 0; S.columns.mvTgX[s] = NaN; S.columns.mvTgY[s] = NaN;
    S.columns.tuS[s] = -1; S.columns.tuId[s] = 0; S.columns.fatF[s] = 0; S.columns.amGx[s] = -1; S.columns.amGy[s] = -1; S.columns.tbT[s] = -1;
    S.columns.cbTick[s] = -1; S.columns.cwTick[s] = -1; S.columns.upT[s] = -1; S.columns.upB[s] = -1;
    // (Its object fields unset: their digest that of none.)
    _simUnitObjClear(S.columns, s);
    S.columns.hObj[s] = _simHDigest0();
    S.columns.rtEnd[s] = -1; S.columns.nvProf[s] = 0; S.columns.nvPK[s] = -1; S.columns.wkIdle[s] = 0; S.columns.wsFail[s] = 0;
    S.columns.hAcc[s] = 0; S.columns.hTouch[s] = 0; S.columns.hSx[s] = 0;
    S.columns.wTeam[s] = -1; S.columns.atkWatch[s] = 0;
    // (Its JavaScript fields at their defaults; the object holds only its
    // slot: its columns, slot, detached values and role memory.)
    _simJsDefaults(S.columns, s);
    // (One descriptor reused: five objects a unit were made for these four.)
    const d = _simSlotDesc; d.value = S.columns; Object.defineProperty(u, '_us', d); d.value = s; Object.defineProperty(u, '_si', d); d.value = null; Object.defineProperty(u, '_det', d); Object.defineProperty(u, '_rm', d); d.value = null;
    S.columns.mvPF[s] = 0;
}

// Removed units may still be attack targets, selected, or referenced in a
// snapshot. Detach their values before reusing the slot; stale object references
// must never read or overwrite a newly spawned unit.
let _simDetValues = null;
// (A slot's object fields unset; on detach the references let go.)
const _simUnitObjClear = new Function('C', 's', SIM_UNIT_OBJ_FIELDS.map(k => 'C.oc_' + k + '.clear(s);').join(' '));
function _simDetValuesCtor() {
    const body = SIM_UNIT_ACCESSOR_COLUMNS.map(k => 'this.' + k + ' = ' + (k in SIM_UNIT_ST_FIELD ? 'C.' + SIM_UNIT_ST_FIELD[k] + '[C.stIx[s]]' : 'C.' + k + '[s]') + (SIM_UNIT_POS_COLUMNS.has(k) ? ' * ' + SIM_POS_INV : '') + ';').join(' ')
        + ' ' + SIM_UNIT_OBJ_FIELDS.map(k => 'this.' + k + ' = C.oc_' + k + '.get(s);').join(' ') + ' this._routeEnd = C.rtEnd[s]; this.watchedByTeam = C.wTeam[s];'
        + ' this.dead = C.dead[s] === 1; this._navLastD = C.mvNavLD[s]; this._floorTile = C.mvFloor[s]; this._sepMoved = C.sepMov[s] & 1;'
        + ' this._statsBehind = false; this._forcedTargetLastSeenX = null; this._forcedTargetLastSeenY = null;'
        + ' { const w = C.wkIx[s], a = C.wkWx[w], b = C.wkWy[w], m = C.wkLmt[w]; this._builderLastWatchX = a === a ? a : undefined; this._builderLastWatchY = b === b ? b : undefined; this._builderLastMoveTick = m === -2147483648 ? undefined : m; }'
        + ' this._dotPending = C.stAc[C.stIx[s]]; this._laserPending = C.lzAcc[s]; this._laserBeam = C.lzBeam[s];'
        + ' this.r = C.r[s]; this.collisionR = C.collisionR[s];'
        + SIM_UNIT_JS_FIELDS.map(([k, kind]) => ' this.' + k + ' = ' + (kind === 'b' ? 'C.j_' + k + '[s] === 1' : kind === 'u' ? '(C.j_' + k + '[s] === C.j_' + k + '[s] ? C.j_' + k + '[s] : undefined)' : kind === 'r'||SIM_UNIT_SPARSE_JS_FIELDS.has(k) ? 'C.' + _simJsName(k, kind) + '.get(s)' : 'C.' + _simJsName(k, kind) + '[s]') + ';').join('');
    return new Function('C', 's', body);
}
function simUnitStateDetach(S, s) {
    const u = S.owners[s];
    if (!u) return;
    // Its values move to one plain object the accessors fall back to (a
    // property definition per column made releasing many units slow; one
    // constructor: one shape, no dictionary transitions per key).
    // (Its row's tables as its own.)
    const statTable = S.columns.statRow[s] >= 0 && typeof _effRowObj !== 'undefined' ? _effRowObj[S.columns.statRow[s]] : null;
    S.columns.statRow[s] = -1;
    const values = new (_simDetValues || (_simDetValues = _simDetValuesCtor()))(S.columns, s);
    // (Its order's references, resolved while its slot is still its: the accessors read the columns.)
    values.targetUnit = u.targetUnit; values.targetBuilding = u.targetBuilding; values.forcedAttackTarget = u.forcedAttackTarget;
    values._attackMoveGx = u._attackMoveGx; values._attackMoveGy = u._attackMoveGy; values.targetPos = u.targetPos; values._routeKey = u._routeKey;
    if (statTable) { values._pc = statTable; values._pce = statTable; }
    values._statsBehind = typeof _unitStatsBehind === 'function' ? _unitStatsBehind(u, S.columns.esVer[s]) : false;
    { const lx = S.columns.fLsX[s], ly = S.columns.fLsY[s]; values._forcedTargetLastSeenX = lx === lx ? lx : null; values._forcedTargetLastSeenY = ly === ly ? ly : null; }
    u._det = values;
    _simJsRelease(S.columns, s);
    // (Its path window back to the pool: the slot's next unit starts with none;
    // its worker record too.)
    simUnitPathRelease(S.columns, s);
    _simWkRelease(S, s);
    _simStRelease(S, s);
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
    // (No smaller than the population's reservation: see simUnitPopulationSlots.)
    const want = Math.max(1024, Math.ceil(Math.max(live * 1.125, simUnitPopulationSlots()) / 4096) * 4096);
    // Already the layout this makes (a match's start into a fresh state: the
    // units in slots 0.. in list order, no gaps) and about its size: kept.
    // (A copy of every column, 1.3 GB at 2M units, beside the reservation's
    // until two ticks later: the wasm heap overflowed in the first ticks.)
    // (Or the units laid out by a plan (simUnitStatePlanSlots: by block, no gaps) and none made since.)
    if (live === units.length && S.cap >= want && S.cap <= Math.ceil(want * 1.25 / 4096) * 4096) {
        const sl = S.sl;
        let same = sl.layout === 1 && sl.nfree < SIM_SLAB && S.owners.length - sl.nfree === live;
        if (!same && live === S.owners.length) { same = true; for (let i = 0; i < units.length && same; i++) same = units[i]._si === i; }
        if (same) { S.unitsRef = units; if (sl.layout !== 1) _simSlabFromLive(S, live); return false; }
    }
    if (typeof simParallelBackgroundWait === 'function' && typeof SIM_PAR_BG_LANES === 'number') for (let lane = 0; lane < SIM_PAR_BG_LANES; lane++) simParallelBackgroundWait(lane);
    const old = S.columns, n0 = S.owners.length, map = new Int32Array(n0).fill(-1);
    // (Less when the heap has no room for that: the live units' slots.)
    const least = Math.max(1024, Math.ceil(live * 1.125 / 4096) * 4096);
    const cap = _simUnitCapThatFits(want, least);
    const N = { cap, owners: [], sl: null, columns: _simUnitColumnsObject(), stamp: new Uint32Array(cap), epoch: 0, unitsRef: units, held: null };
    const C = N.columns;
    N.pathPool = S.pathPool; C.mvNodes = old.mvNodes;
    // (The worker records stay: wkIx is copied with the columns.)
    N.wk = S.wk; for (const [k] of SIM_UNIT_WK_SIDE) C[k] = old[k];
    // (The status records too: stIx is copied with the columns.)
    N.st = S.st; for (const [k] of SIM_UNIT_ST_SIDE) C[k] = old[k];
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
    // (In the order of their blocks, by list order within one: slots by place,
    // see the allocator. Their old slots then rarely run on, and a column is
    // copied unit by unit.)
    const lv = [];
    for (let i = 0; i < units.length; i++) { const u = units[i]; if (u && u._us === old && S.owners[u._si] === u) lv.push(u); }
    const sl0 = _simSlabNew(), lvKey = new Int32Array(lv.length), lvCount = new Int32Array(sl0.nk + 1), lvOrder = new Int32Array(lv.length);
    for (let i = 0; i < lv.length; i++) { const k = _simSlabKey(sl0, lv[i].x, lv[i].y); lvKey[i] = k; lvCount[k + 1]++; }
    for (let k = 0; k < sl0.nk; k++) lvCount[k + 1] += lvCount[k];
    for (let i = 0; i < lv.length; i++) lvOrder[lvCount[lvKey[i]]++] = i;
    for (let j = 0; j < lv.length; j++) {
        const u = lv[lvOrder[j]];
        const s = u._si, r = runs.length;
        if (r && runs[r - 2] + runs[r - 1] === s) runs[r - 1]++;
        else runs.push(ns, s, 1);
        N.owners[ns] = u; map[s] = ns;
        u._us = C; u._si = ns;
        ns++;
    }
    for (const k of SIM_UNIT_COLUMNS) _simCopyRuns(old[k], C[k], runs, 1);
    for (const [k, kind, def] of SIM_UNIT_JS_FIELDS) {
        const nm = _simJsName(k, kind);
        if (kind === 'r') C[nm] = _simRefCopy(old[nm], cap, runs);
        else if (SIM_UNIT_SPARSE_JS_FIELDS.has(k)) C[nm]=_simSparseIntCopy(old[nm],cap,def,runs);
        else { C[nm] = new _SIM_JS_TYPED[kind](cap); _simCopyRuns(old[nm], C[nm], runs, 1); }
    }
    for (const [k, , per] of SIM_MOVE_COLUMNS) _simCopyRuns(old[k], C[k], runs, per);
    _simCopyRuns(S.sepKey, N.sepKey, runs, 1); _simCopyRuns(S.sepLayer, N.sepLayer, runs, 1);
    // (The object fields' arrays: as long as the columns, copied the same way.)
    for (const k of SIM_UNIT_OBJ_FIELDS) {
        C['oc_' + k] = _simRefCopy(old['oc_' + k], cap, runs);
    }
    for (let s = 0; s < ns; s++) {
        const t = C.tuS[s];
        if (t >= 0) C.tuS[s] = t < n0 ? map[t] : -1;
    }
    // The rest (removed, not yet collected): detached from the old state.
    for (let s = 0; s < n0; s++) if (S.owners[s] && map[s] < 0) simUnitStateDetach(S, s);
    _simUnitPrepFree(S);
    _simSlabFromLive(N, ns, true);
    _simUnitState = N;
    if (typeof simParallelBindBatch === 'function') simParallelBindBatch();
    for (const k of SIM_UNIT_COLUMNS) simParallelBind('unit.' + k, C[k]);
    for (const [k] of SIM_MOVE_COLUMNS) simParallelBind('unit.' + k, C[k]);
    simParallelBind('unit.mvNodes', C.mvNodes);
    simParallelBind('unit.sepKey', N.sepKey); simParallelBind('unit.sepLayer', N.sepLayer);
    if (typeof simParallelBindFlush === 'function') simParallelBindFlush();
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
const SIM_UNIT_COLLECT_BLOCK = 1024;
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
    // Sweep contiguous blocks rather than every 64th slot: the old stride
    // fetched a whole cache line per dead-byte test and scattered each
    // detached unit's column reads across the whole multi-GB allocation.
    // Each slot is visited once in 64 steps, independent of growth.
    const DEAD = S.columns.dead, block = SIM_UNIT_COLLECT_BLOCK;
    // A cursor per simulation step, not gameTime modulo 64: adaptive dk
    // (e.g. 4 or 20) would otherwise visit only a subset of the slices and
    // retain the other dead units and their worker/path records forever.
    const phase = all ? 0 : (S.collectPhase || 0);
    if (!all) S.collectPhase = (phase + 1) % SIM_UNIT_COLLECT_SLICES;
    const first = phase * block;
    const stride = all ? Math.max(1, owners.length) : block * SIM_UNIT_COLLECT_SLICES;
    for (let b = first; b < owners.length; b += stride) for (let s = b, end = all ? owners.length : Math.min(b + block, owners.length); s < end; s++) {
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
    // (Its JavaScript fields and radii: accessors over columns, as before own fields.)
    if ((u._us || u._det) && u instanceof Unit) { keys.push('r', 'collisionR'); for (const k of SIM_UNIT_JS_SNAPSHOT_KEYS) keys.push(k); for (const k of SIM_UNIT_MOVE_SNAPSHOT_KEYS) keys.push(k); }
    if (u instanceof Unit) for (const k of SIM_UNIT_EXTRA_ACCESSORS) if (!Object.prototype.hasOwnProperty.call(u, k)) keys.push(k);
    // (Its role memory's fields that hold something: unit.js UNIT_ROLE_FIELDS.)
    if (u._rm && typeof UNIT_ROLE_FIELDS !== 'undefined') for (const k of UNIT_ROLE_FIELDS) if (u._rm[k] !== undefined) keys.push(k);
    return keys;
}

// Scratch sized by population, in whole 4096-element blocks. At a million
// entries, 3.125% headroom already covers 32k births; 12.5% across the
// separation/acquisition/index pools wastes hundreds of MB at 4M units.
function simReserveCap(n, min = 1024) { return Math.max(min, Math.ceil(n * (n >= 1048576 ? 1.03125 : 1.125) / 4096) * 4096); }
// One slot list for the tick's phases that list units one after another, each
// used up before the next fills it (main.js _gameTickBody): the status
// pre-pass's (st.list), the unit events' (ev.list), the dead units' (retire.list).
// Three lists as long as the slots cost 12 bytes a unit (48 MB at 4M).
let _simPhaseList = null;
function simPhaseList(len, min = 8192) {
    if (!_simPhaseList || _simPhaseList.length < len) {
        _simPhaseList = simSharedArray(Int32Array, simReserveCap(len, min));
        for (const nm of ['st.list', 'ev.list', 'retire.list']) simParallelBind(nm, _simPhaseList);
    }
    return _simPhaseList;
}

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

const _simPathPoolsGone = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(h => { if (SIM_HEAP_GC_FREE & 2) simHeapFree(h.array); }) : null;
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
    // (Worker records: a record a worker, no bytes a slot; see SIM_UNIT_WK_SIDE.)
    for (const [name, Type] of SIM_UNIT_WK_SIDE) {
        if (out[name]) throw new Error('Duplicate unit column: ' + name);
        out[name] = Object.freeze({ Type, count: 1, bytes: 0, recordBytes: Type.BYTES_PER_ELEMENT, side: 'wk', snapshot: false, group: 'worker',
            default: name in SIM_WK_DEFAULTS ? SIM_WK_DEFAULTS[name] : 0 });
    }
    // (Status records: a record a unit with a status, no bytes a slot; SIM_UNIT_ST_SIDE.)
    for (const [name, Type] of SIM_UNIT_ST_SIDE) {
        if (out[name]) throw new Error('Duplicate unit column: ' + name);
        out[name] = Object.freeze({ Type, count: 1, bytes: 0, recordBytes: Type.BYTES_PER_ELEMENT, side: 'st', snapshot: false, group: 'status', default: 0 });
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
        statusRecords: simUnitStUsed(), statusCap: S && S.st ? S.st.cap : 0,
        boundBytes: groups, heap: typeof simHeapStats === 'function' ? simHeapStats() : null };
}

// Static stats have no per-instance backing arrays. JavaScript's slow
// paths read the same shared row as Rust; detached/custom stats read their
// existing shared object until their row is attached.
function simUnitStatValue(c, s, k) {
    const r=c.statRow[s];
    if(r>=0 && _effHot) return _effHot[r*EFF_HOT_WIDTH+k];
    const u=_simUnitState && _simUnitState.owners[s], pc=u && u.preComputed;
    if(!pc) return NaN;
    switch(k) {
        case 0:return Math.fround(pc.speed);
        case 1:return Math.fround(Math.max(.01,pc.astarCost));
        case 2:return Math.fround(Math.max(TILE*.6,Number(pc.speed)||1));
        case 3:return Math.fround(Math.max(TILE,pc.visionRange*TILE));
        case 4:return Math.fround(pc.attackCooldown);
        case 5:return Math.fround(pc.attackDamage);
    }
}
