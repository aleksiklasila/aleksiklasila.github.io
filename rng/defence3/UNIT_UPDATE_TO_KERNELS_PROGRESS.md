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

## State of the tests

All regression files pass after the pass was removed (2026-10-23; tests/test-runs/regress-ordk*.json for the later runs). Tests
that only checked the deleted code were removed (drive-by-attack, held-attacker-park, nav-crowd-arrival, laser-performance,
unit-ctl-diff); the rest were adapted (see git diff tests/).

## Numbers (10x mega, 1.77M units)

mean 299 ms a tick (was 417 before the controller): simMoveRun 173 (movement kernel 118), no per-unit pass.

## The pass is gone (2026-10-23, rules revision 34)

`_forEachUnitInTickOrder`, `_unitPassUpdate`, `Unit.update` and every `do*` method, `followPath` / `_followNavNode`, the drive-by
scan, the legacy arming (`simMoveTryHold` / `Chase` / `ApproachBuilding`, mvOn 3, 4, 5, 7) and the out-code commit family (out 6-15)
are deleted. The tick is now: `simMoveRun()` then `unitEventsRun()` (unit.js), then hits.

- Attack orders (commandState 3) are the controller's every tick: mv.rs `forced` / `close_in` / `order_done`. Unit target
  (tuS / tuId, forced fatF: kept while in sight or in contact, last seen fLsX / fLsY, out of sight -> a move there; not forced:
  leash 8 tiles), structure target (tbT). In range: k <= 2 area steps worked out in the kernel, beyond that the brain's word
  (k_acq_snap puts the order's target into acq.cm 32 / 48, k_combat_brain answers 32|1 or 32|2; combat4 skips bit 32). Closes in
  straight (fly, < 2 tiles, or the step and the target tile open within 6 tiles) else by the ground atlas (mvOn 6, mvWk 4, mvHT).
  The order actions call `unitAttackOrder(u)` (no path of their own). Retaliation is gone (it was off with the brain anyway).
- Scouts: `scout_on` (destination by `hash_rand` = simHashRand, grid of 32 cells a side, air atlas), `scout_rest` after arrival.
- Events (unit.mvEv, mv.rs EV_*): 1 floor item the kernel cannot apply (mines), 2 no way on (flow look 0), 3 a wait that ended near
  its target, 4 not in the index / off map, 5 a worker's check tick on its way (the kernel moves it on, the AI looks after).
  `k_unit_events` lists live units with an event or no output (workers), `unitEventsRun` sorts them by a hash of (tick, id) and
  handles them: workers (`_unitWorkerEvent`: AI, the way's end without a JS step, the second AI call, re-arm; budget
  WORKER_EVENTS_PER_TICK), `_unitFloorEvent`, `_unitNoWay` (pending target), `_unitWaitEnded`. Then `k_dead_mark` (all units whose
  energy ran out; replaces HELD_DEAD) and `simPassWallFixups` (all units, any output).
- Fixed on the way: occupancy tail groups (n < 4) of unarmed slots were skipped as "quiet" and never reached the controller.

Left for later (not on the main path's per-unit cost): workers' AI is still JS per event (5b: kernels with effect records, needs
structures as columns), move_path / tile-path windows in the kernel are now unused, stale comments that name deleted functions,
vectorizing the scalar ctl / forced paths.

## Gameplay changes to tell the user about

- Effective levels are area based (0a own area, 1a adjacent, ...); `AREA_UNIT_TILE_EQUIVALENT` is going away.
- Structures are a brain instruction (cmMode 16); held units never chase, and fire only in range.
- A dead target is none at once (an attacker that loses its target goes on with its attack-move the same tick).
- A moving or attack-moving unit's arrival in a crowd and its re-routing now follow the controller's rules (the differences found
  by unit-ctl-diff: arrival timing within a tick or two, crowd settling positions within a tile and a half).

## Responsiveness at low TPS (2026-10-23, after the pass)

- Orders: the order queue runs newest first per player; small actions jump the action backlog (main.js `_actionJumps`, within
  ACTION_JUMP_BUDGET_PER_TICK; the units / rally tiles they took are marked with their arrival and older waiting actions pass
  them over: the latest order still wins). Move / attack-move orders of 64+ units go through the order kernel (k.rs
  `k_order_move`, SIM_KERNEL_ORDER_MOVE: columns only, the controller arms them on the atlas in the same tick; units with a
  pending way, a fallback path, workers, held units... still the JavaScript's) at 1/16 of a JS unit's budget. probe:
  tests/test-runs/probe_rallylat.cjs (200k units, ten 20k-id clicks then a 40-unit click: the small order next step, the whole
  army's last order in the first step; before: 5 steps), probe_ordk.cjs (one kernel order's columns tick by tick).
- Areas are whole in the tables for attack range and work distance (data_dynamic.js AREA_STAT_KEYS, floor: the kernels'
  count); sight stays raw (its 0 means none, 0.2-0.8 its own area: every use counts whole steps above 0) and is shown whole.
- Build ghosts live until the simulation ran the placement's tick (renderer.js PENDING_BUILD_*; queueAction returns the tick).
- Fight looks: the hits' looks are picked inside the page's view first (k_hits Looks, unit.js simLookView, sent by
  sim_client.js simClientNoteView), SIM_HITS_PRESENT a base tick (x simDk, up to 4096) + 128 outside; effect records start at
  points spread over the step they came in (particle.js combatFxSpan) and play on the drawn units' clock
  (sim_client.js simClientDrawnGameTime: the presentation's play position; was gameTime + tickAlpha, which froze a step's
  effects at their first frame for the whole step at low TPS and dropped them at the next); unit attacks are drawn between
  their attacker and target as drawn (combatFxIds; a beam's ends follow both). Towers' shots beside the worker are drawn from
  their muzzle records as volleys (effects3d.js _fxVolley: the step's shots, each flying to its target as drawn), not from the
  sampled projectiles. Probe: .claude/fight_fx_probe.cjs (Edge, BASELINE=1 for the old clock and looks).
- Still open: zoomed-out FPS, multiplayer end-to-end latency at ~100 ms ping (wire: a 1.09M-unit team of the 4M close-up scene
  is ~16.8k id runs, so an order's uidz is ~100 KB, not MBs), selection lag of 2M-unit boxes, unit attack animations at low
  TPS (attackFlash is sampled per presentation frame).
