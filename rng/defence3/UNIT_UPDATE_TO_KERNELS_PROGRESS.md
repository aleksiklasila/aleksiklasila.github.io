# Unit.update / _forEachUnitInTickOrder into kernels and brains: progress

Goal (the user's): nothing of `Unit.update` or `_forEachUnitInTickOrder` stays on the main tick path. What can be done in
O(1) kernels is; what cannot is a brain (helper-thread decision lane, committed in O(decisions)); the main thread only applies
O(effects). Targets: units and buildings, active fighting/working units first, measured at 10x counts
(1000x1000 / 2000x2000 maps, the atlas for routes).

Last updated 2026-10-23. Companion notes: OPTIMIZATION_PROGRESS.md, BRAIN_OFF_MAIN_THREAD_PLAN.md,
MEMORY_OPTIMIZATION_PROGRESS.md, CROWD_SEPARATION_PROGRESS.md.

## Done

Order state is columns, with accessors on the Unit object (sim_unit_state.js SIM_MOVE_COLUMNS, unit.js accessors):
`targetUnit` (tuS slot hint + tuId), `targetBuilding` (tbT tile), `forcedAttackTarget` (fatF), `_attackMoveGx/Gy` (amGx/amGy),
`targetPos` (mvTgX/mvTgY), `_routeKey` (rkF), `_routeEnd` (rtEnd + nvProf), `path` (nvPK = one atlas node: profile, destination,
wide; the getter makes the node object when a kernel wrote the key), `holdPosition` (holdF).

Combat brain (k_acq_snap -> acq scan -> k_combat_brain -> k_combat_commit; instruction in cmMode/cmT/cmTId):
- units and structures: cmMode bits 0-1 (1 stand, 2 chase), 4 fire, 16 structure target (mv.rs `move_struct`, `approach_tile`).
- held units never chase (flag 32); structure hits applied in attacker-id order (`_structHitsApply` in unitHitsResolve).
- the JS structure engage (`_brainStructureEngage`) is gone; Unit.update calls at 10x went 5,700 -> 1,020 a tick.

Unit controller `ctl` (wasm/src/mv.rs, section THE UNIT CONTROLLER) for units that are not workers: reads the order from the
columns and arms the flow (atlas), parks, ends the order, retries after `move_flow`, arrival in a crowd (wk marker 5),
attack-move resume, route-end continuation. It hands a unit back to Unit.update (out 0, unarmed) for: workers, scouts, a
hostile floor item under it, `scoutT`, forced attacks, an unreachable way. Switch `_simUnitCtlOn`.
- test: tests/unit-ctl-diff.test.cjs (same orders in two worlds, controller on / off: <= 4 of 324 unit states differ).

Other kernel moves this stretch: effective-level behind-count in k_eff_units (P[24], eff.bcnt); `k_snap_units` mixes the order
columns; rules revision 33.

Bugs found and fixed while testing the controller:
- tests/movement-sleep.test.cjs compared against an old kernel that has no controller: the test switches the controller off.
- Desync after a repair (multiplayer-chaos-determinism, multiplayer-extremes, multiplayer-patch): the `targetUnit` getter
  returned a dead target only until its slot was freed, and the slot sweep frees slots at each peer's own time; the hash read the
  stale raw tuId (a patched guest cleared it, the host kept it). Now: a dead target is none (getter), a target not in a slot yet
  is found by id (`getUnitById`, a restore sets targets before the targets have slots), `simUnitTargetsResolve()` makes the
  slots before the hash, and `k_snap_units` mixes the target's id only while it stands in its slot alive (arg 43, unit.tuS).
  `doAttacking`'s last branch now also calls `_resumeAttackMove()` (a dead target used to do that).

## State of the tests (full regression `node tests/run-regressions.cjs 2 --modes=0`, 213 files)

Stopped at 106 done to fix the above. Failed so far: movement-sleep (fixed), multiplayer-chaos-determinism, multiplayer-extremes,
multiplayer-patch. After the target fix above the chaos test passes on the random map, but multiplayer-extremes still fails
("exact after the patch", tick 889 / 890, host vs guest4) and multiplayer-patch still fails (a full restore: u43 and u56 have
targetUnit u158 on the host, null on the restored guest one tick after the restore; the guest's getter finds no u158, probably
because the restored guest has u158 dead or not in `units` while the host still returns it: to look at first, with
tests/multiplayer-patch.test.cjs mapCase 'crossroads'). Work stopped here at the user's request. deltatick-multiplayer (the controller changes who wins: the match ends before
the scripted divergence is repaired; the scenario / timing must be adjusted, not a protocol bug), deltatick-fairness
(pre-existing), pending-damage-restore and render-frame-stability (pre-existing). Must be run again in full after the fix.

## Numbers (10x mega, 1.75M units, tests/test-runs/active-20261023/)

mean 417 ms a tick before the controller was wired: simMoveRun 257 (movement kernel k89 176 wall, k8 63),
_forEachUnitInTickOrder 31, spatialIndexRebuild 28, recalculateUnitEffectiveLevel 14. No clean run since the controller; a clean
10x run and a pass profile (pass_probe.js / pp_run.sh / pp_table.cjs) are still to do.

## What is left to get rid of _forEachUnitInTickOrder

What still reaches `fn(u)` = `_unitPassUpdate` -> `Unit.update` (from the pass profile, per tick at 10x, before the controller):
worker events ~70% (RETURNING_FOR_GOLD, IDLE healer / builder / collector, MOVING_TO_*), forced attackers ~1 ms, nav-path moves and
attack-moves (now the controller's), scouts, hostile floor items, unreachable ways.

1. Forced ATTACKING (orders `attack` / `attackBuilding`, retaliation `_issueRetaliationPath`):
   brain snapshot with the forced flag and target columns (fatF, tuS / tuId, tbT); forced rules: the target stays while it is in sight
   or in contact, no leash, no switching; lost sight -> a move to the last seen position (fLsX / fLsY), dead -> idle and resume the
   attack-move; a structure target as a structure instruction that ends when the structure is gone or out of sight. ctl handles
   cmd 3 (chase by the atlas when the straight step is blocked, flyers and < 2 tiles straight).
2. Scouts in ctl: random destination from `simHashRand(gameTime, id, 1 / 2)` ported bit-exact, `_nextScoutRetargetTick` column,
   flight to the target by the air atlas, hold keeps the destination.
3. Floor items under a unit (sand / lava / poison / ice / water status effects on entering and once a second; a mine going off):
   the kernel decides (which tile, which item), the statuses are written as effect records applied O(effects), a mine is an event
   in a list handled by `_explodeMine` (rare).
4. Unreachable way (`_followNavNode` lk == 0: `_pendingPathTarget`, `navPathSubstitute`, `notePendingPathUnit`, the pending resolver
   and `_tryUpgradeAstarFallbackPath`): ctl parks the unit as a waiter and posts the request; the resolver stays a tick-start job.
5. Workers (all of `updateWorkerAI`, ~4,400 lines of worker.js):
   a. first the event list: the kernel lists the workers whose way ended / that are idle past their check, the main thread handles
      that list in a deterministic order (hash of tick and id, the same on every peer) with the existing JS under the per-tick event
      budget; no per-unit pass, no `Unit.update` wrapper;
   b. then the hot events into kernels with effect records (kernel decides, JS applies O(effects), per-owner atomic accumulators):
      the collector cycle (deposit, next site from the search tier), the builder trip (spawner, material, build step), healers,
      researchers, salvagers. Prerequisite: structures as columns (stage S: energy, owner, work flags, build progress, spawner
      queues), so a kernel can read and write what a worker acts on.
6. Delete: `_forEachUnitInTickOrder` / `Body`, `_unitPassUpdate`, the `SIM_KERNEL_UPD_CAND` candidate list, `SIM_KERNEL_HELD_DEAD`,
   `simPassWallFixups` (the wall case becomes a kernel list), the out-code protocol (6, 10-15 and the `sim*Commit`, `simHold*`,
   `simChase*`, `simEngageCommit`, `simTargetDiedCommit`, `simDriveByFire` family), the legacy arming (`simMoveTryHold`,
   `simMoveTryChase`, `_simMoveTryApproachBuilding`, mvOn modes 3-7, `simMoveTryArm` / `TryPark*` for non-workers), the shuffled block
   order (replaced by the hash order of 5a), `Unit.update` itself, `doIdle` / `doMoving` / `doAttackMoving` / `doAttacking` /
   `doHolding`, and the sepMov bookkeeping for JS-moved units.
7. Then vectorize the scalar ctl / struct-approach / forced-chase paths in `move_span` (4-lane groups), measure, test.

Order of work: 1, 2, 3, 4 (one pass, then build wasm32 + wasm64, run unit-ctl-diff, structure-instruction, chaos, patch, full regression,
clean 10x run) -> 5a -> remove the pass -> 5b step by step -> vectorize.

## Gameplay changes to tell the user about

- Effective levels are area based (0a own area, 1a adjacent, ...); `AREA_UNIT_TILE_EQUIVALENT` is going away.
- Structures are a brain instruction (cmMode 16); held units never chase, and fire only in range.
- A dead target is none at once (an attacker that loses its target goes on with its attack-move the same tick).
- A moving or attack-moving unit's arrival in a crowd and its re-routing now follow the controller's rules (the differences found
  by unit-ctl-diff: arrival timing within a tick or two, crowd settling positions within a tile and a half).
