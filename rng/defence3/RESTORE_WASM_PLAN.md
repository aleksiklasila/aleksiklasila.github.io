# Restore in wasm: units as columns in the snapshot

Why (2026-11-19, MULTIPLAYER_ROBUSTNESS_PROGRESS.md): a full restore of ~105k units takes ~10 s (encode 3.6 s on the
sender, decode 6.0 s on the restoring peer, flush 0.3 s; `RESTORE_SPLIT=1` on tests/chaos-spikes.bench.cjs
`--units=131072 --worker-min=8000 --structures=60000 --restore-at=30`). Every full resync, join or reload freezes the
host's worker while it encodes and the restoring peer while it decodes. At 1M units the restore did not finish in
40 min (tests/CHAOS_SPIKES_BENCHMARK.md).

Profile of the restore (`--profile --profile-start=30`, tests/test-runs/mp-validate-20261119/rprof.json.cpuprofile),
inclusive: encode 3.5 s of which `_snapEncodeRow` 2.9 s (per entity: shape lookup `_snapShapeOf`, keys
`simUnitStateKeys`, accessors, `_snapRootRef` / `_snapEObj` references); decode 5.8 s: `_snapNewShell` 1.4 s (Unit
construction 1.1 s), the rows' `fill` 1.4 s / `assign` 1.2 s / `diff` 1.9 s, `simMoveStatsChanged` 0.7 s, GC.

Units already live as columns in the wasm heap (sim_unit_state.js), births are batch kernels without JS objects
(spr.rs `k_spawn_write`, lazy unit objects), and the hash already reads the columns (`k_snap_units`). The JSON row
per unit is a detour through objects.

## Design

Snapshot unit section = a binary block (base64 in the JSON envelope, or a separate transfer) of:
- a header: count, the column list with types (a version tag: the rules revision);
- per column, the values of every live unit in id order (gathered by slot through the id index, `k_slots_by_id`);
  the columns that are state (what `SIM_UNIT_KCOL_FIELDS`, the hash's fields and the snapshot's `u` keys name today),
  each at its storage width (Int8 owners, f32 positions in eighths, ...);
- per-unit references (target unit, target building tile, worker target) as ids / tiles, columns too;
- side records (worker records `wk`, status records `st`) as their own column blocks, by the unit's index;
- the JS-only parts that are not columns yet (paths `simPathStore`, `_fpPath`, `attackTarget`, the 15
  `SIM_UNIT_JS_FIELDS`, the object fields): first make them columns where they are state (hard rule: no JS fallback),
  paths as a flat node array + per-unit offsets.

Encode: one kernel gathers each column into the block (parallel by column / id range), no JS object touched.
Decode: the restore's reset (`simUnitStateReleaseAll`), then one batch "birth" of n units into slots 0..n-1 (as
spr.rs, handles and id index made in the kernel), then a scatter kernel per column block, then the derived state
(stat rows from the tables, occupancy, index) by the existing kernels. No `Unit` construction (lazy objects), no
per-unit `simMoveStatsChanged` (the flush disarms all anyway).

Structures next, the same way (class tables `_ST` are columns already).

## Inventory (2026-11-19: `simUnitStateKeys(u)` of a worker unit, 92 keys)

id owner x y prevX prevY vx vy energy pathIndex commandState attackTimer attackFlash teleportHideTicks burning
burnTickDamage poisoned poisonTickDamage frozen iceTickDamage wet sandy watched workerTransferCooldown stackCount
unitLevel baseLevel effectiveStacks effectiveLevel _lastAppliedEffectiveLevel r collisionR _removedNow isFlying _okTile
_okVer _okNodeTile _okNodeVer _effectiveStatsStamp maxEnergy unitType _fpPath attackTarget atkL wtcL path
targetBuilding targetPos _routeKey targetUnit forcedAttackTarget _attackMoveGx _attackMoveGy pathIsFallbackAstar
_pptSnap workerState _workerNextIdleRetargetTick dead _navLastD _floorTile _sepMoved _statsBehind
_forcedTargetLastSeenX _forcedTargetLastSeenY _builderLastWatchX _builderLastWatchY _builderLastMoveTick _routeEnd
watchedByTeam holdPosition _astarBudgetRetryTick _scoutTarget workerType workerTargetType _workerReservedTileIndex
builderHasMaterial healerHasMaterial researcherHasMaterial _routeSegEnd _navReady _awaitGroupPath _idleFailVer _effOk
_effRad _effType _wkTgt _dotPending _laserPending _laserBeam _builderNextRecheckTick carryingValue _idleFailUntil

Where they come from (`simUnitStateKeys`, sim_unit_state.js): `SIM_UNIT_ACCESSOR_COLUMNS` (30: id owner x y prevX
prevY vx vy energy pathIndex commandState attackTimer attackFlash teleportHideTicks burning burnTickDamage poisoned
poisonTickDamage frozen iceTickDamage wet sandy watched workerTransferCooldown stackCount unitLevel baseLevel
effectiveStacks effectiveLevel _lastAppliedEffectiveLevel), `r`/`collisionR`, `SIM_UNIT_JS_SNAPSHOT_KEYS` (11, incl.
unitType: a per-peer type index (upT), so a name table travels), `SIM_UNIT_MOVE_SNAPSHOT_KEYS` (atkL wtcL),
`SIM_UNIT_EXTRA_ACCESSORS` (44: references, worker state, kernel columns), `UNIT_ROLE_FIELDS` (11, the sparse JS role
memory `u._rm`), `SIM_WK_MEM_KEYS` (24 worker-memory columns of the wk record, kinds T = a target reference, Y, N).
`SNAP_SKIP_KEYS` (57) never travel (presentation, caches, peer-local slots).

Restore cost by list (131k scene, `RESTORE_JS=@tests/test-runs/mp-validate-20261119/restore-breakdown.js`, real clock
`__scratch.realNow`, with the wrappers' overhead): encode 4.8 s = unit rows 3.1 s, structure rows 0.9 s, the rest
0.8 s; decode 8.6 s = unit shells 1.9 s (the Unit constructor), unit fields' assign 1.1 s, structures 0.5 s, the rest
(stat refresh `simMoveStatsChanged` / `simMoveRefreshAllStats`, nav restore, tile entities, match prepare, spatial
index, digests, the slot reset) ~5 s spread. Units first.

Not plain numbers (need a column form first): path (+ pathIndex), _fpPath, attackTarget, targetUnit,
forcedAttackTarget, targetBuilding, targetPos, _wkTgt / workerTargetType, _scoutTarget, _pptSnap, unitType
(type index upT), workerType (shared id), holdPosition, _routeKey, atkL / wtcL. The rest are columns or JS-field
columns already (`SIM_UNIT_KCOL_FIELDS`, `SIM_UNIT_JS_FIELDS`, wk/st records).

## Inventory, revisited (2026-11-19 evening, census `tests/test-runs/mp-validate-20261119/unit-key-census.js`)

A 28.5k-unit chaos scene's snapshot keys by value kind: all numbers / booleans except `unitType` (names), `path`
(arrays), `targetPos` ({x, y}), `_routeKey` ('nav' / null), `_pptSnap` (rare object), `workerState` /
`workerType` / `workerTargetType` (names), the worker memory's `T` references (structures) and `Y` names. Every one
of them is a heap column (or a worker / status record column, or the path store) behind its accessor already:

| key(s) | column(s) | note |
| --- | --- | --- |
| id owner x y vx vy energy r collisionR pathIndex commandState attackTimer attackFlash workerTransferCooldown, levels | slot columns | prevX/prevY = x/y |
| teleportHideTicks burning ... iceTickDamage, _dotPending | st record (stTh ... stId, stAc) | via stIx |
| _removedNow isFlying maxEnergy | jRmNow jFly jMaxE | |
| unitType | upT | peer's type index: names table travels |
| atkL wtcL | atkL wtcL | |
| path | pthH (path store) + nvPK | unique paths once (shared rally paths), nodes from pathIndex-1 |
| targetBuilding | tbT, acqB | raw (a gone structure's tile kept, as on the source) |
| targetPos / _routeKey / forcedAttackTarget / _attackMoveGx,Gy | mvTgX mvTgY / rkF / fatF / amGx amGy | |
| targetUnit | tuId | tuS (slot hint) remade from the id hash |
| pathIsFallbackAstar, _pptSnap | ptSt ptGx ptGy ptCmd ptSrc ptVer ptAt ptSub, mvPP mvPF | |
| worker task keys | wkS wkT wkR wkN wkIdle | |
| dead _navLastD _floorTile _sepMoved | dead mvNavLD mvSteer[5] sepMov | |
| _statsBehind | esVer (-2 behind / -3 not) | the bit computed by the gather |
| _forcedTargetLastSeenX,Y / _routeEnd / watchedByTeam | fLsX fLsY / rtEnd nvProf / wTeam | |
| _builderLastWatch*, _builderLastMoveTick, worker memory | wk record (wkWx wkWy wkLmt, wm*) | via wkIx |
| holdPosition _scoutTarget workerType | shared-id columns (oc_*) + holdF isWk wbType wbTick | pool values table travels |
| _astarBudgetRetryTick | its Float64 column | |
| _routeSegEnd _navReady _awaitGroupPath _idleFailVer _effOk _effRad _effType | rsEnd navRdy agWait idleFV esOk esRad esType | |
| _laserPending _laserBeam | lzAcc lzBeam | |
| _astarBudgetBlockedUntil _nextScoutRetargetTick | **JS role memory: to become columns** | |
| attackTarget | presentation only (draw effects) | not state: dropped |

So the block is raw state columns in id order; nothing needs a JS object. Decode = a restore births kernel modeled on
spr.rs `k_spawn_births` (slab allocator by position key, handles, slot defaults (Z table), the id table and hash,
worker / status records, footprint records), the carried columns scattered over the new slots, then the existing
batch kernels (spatial list, upkeep bins) and the derived passes made batch (stats rows, digests).

## Steps

1. Inventory: every field the `u` rows carry today -> its column (or the missing column to make). Tests:
   tests/storage-abi.test.cjs, tests/snapshot-*.test.cjs, multiplayer-snapshot / -patch / -chaos-determinism.
2. Make the remaining JS-only unit state columns (paths first).
3. Gather/scatter kernels (Rust, wasm/src/snap_units.rs), the binary block in the envelope; encode and decode both
   switch at once (no JSON unit rows left; SNAP_FORMAT bump).
4. Partial patches (`RESYNC_PATCH` buckets) use the same block for the units of their regions.
5. Measure: the 131k restore split, then 1M; the restore-vs-flush check (identical hashes) must stay.
</content>
</invoke>
