# Multiplayer robustness: progress

Goal (the user's, 2026-10-24): make the current version robust before any further optimization: fix every
nondeterminism, desync and error in multiplayer (and anything else the regression finds). Graphics and FPS are
good enough for now.

Start here: commit `7c1099e` ("3d fixes") holds all of the 2026-10-24 session's work (see "What changed").

## Known failing tests (as of 7c1099e)

From the full regression (`node tests/run-regressions.cjs 3`, both modes; results in
`tests/shared-state-final-validation.json`) and reruns after the fixes below:

| Test | Mode | Status | Pre-session code (6fcca4c) |
|---|---|---|---|
| multiplayer-extremes | worker (SIM_WORKER=1) | FAIL: "exact after the patch": host vs guest4 differ for ticks after a forced divergence's patch, maxed research | PASS |
| multiplayer-chaos-determinism | worker | FAIL: "random: nondeterministic divergence at tick 368 (host vs guest3) in [units]" (units: snake 137, astar_collector 145, builder_unit 152, fire/water/ice_resistant) | PASS |
| load-world | worker | FAIL: SIM_KERNEL_SNAP_REGION "module=false, args=false" (wasm not loaded in the worker) | FAIL too |
| worker-created-start | worker | FAIL: "the page-only start made the world" (units 0) | FAIL too |
| solo-snapshot | worker | FAIL (passes in page mode) | FAIL too |

So the first two are regressions of the 2026-10-24 changes (pass on 6fcca4c, fail on 7c1099e); the last three
already failed before (worker-mode harness/wasm loading in node: check whether they are environment problems,
e.g. low free memory on this machine, or real bugs).

`multiplayer-extremes` passed in page mode with DIVTRACE (tests/test-runs/extremes_div.cjs, a copy that prints
`H.divergenceReport` on a mismatch). Confirmed on the final code (worker mode, rerun after every fix): both still
fail the same way. Chaos detail: guest3 keeps diverging after its repairs (repairs at ticks 306, 394, 494, 568);
the host saw "players", "globals" and units differ (tiles 4-7,24-27: astar_collector 145, snake 137, builder_unit
152, fire/water/ice_resistant; later tank, flying, laser_resistant), i.e. players/globals diverge too, not only
units: look at what a patch restores for players (research levels, stat tables, the action backlog) in worker mode.
Note: in page mode both pass, so the cause is likely something the worker-side restore (or the worker's own
copy of a page-side value) misses.

Fixed during the session (were failing in that regression): worker-walk (old configs' workers had range 0:
data_dynamic.js migrateThingStatsAreas and the legacy-table import now move workerSearchDistance into a worker's
attackRange), separation-presentation (frame slot bytes rounded up to 4), visibility-shared-source,
battle-performance, performance-regressions, collector-farms (test sandboxes / CRLF), shared-unit-state,
lod-atlas-preparation, research-menu, combat-reach, combat-effects (tests adapted).

## What changed on 2026-10-24 that can touch determinism (suspects, in order)

1. Area stats (rules revision 35 -> 36, utils_snapshot.js SIM_RULES_REVISION): only Range (attackRange) and
   Visibility (visionRange) per thing, whole steps (data_static.js areaSteps). Workers' Range = their work reach
   (workerSearchDistance removed; stat rows carry `rangeIsWork`, `visionOwn`). Vision 0 = 0a (own area): fences,
   floor items and every unit are now visibility sources (renderer.js _visCoverSync / _visCoverSyncUnit,
   things_utils.js rVsA never -1). Check: restore/patch paths rebuilding vis cover, stat rows (_effRowWrite) and
   `_applyUnitPlayerPrecomputedStat` incremental updates vs a full rebuild after a patch with maxed research.
2. Action order: a 'place' action now jumps the action backlog unless a waiting action touches its tile
   (main.js _actionJumps). The backlog is state (snapshotted); check the snapshot/restore of the jump allowance
   and arrival sequence.
3. Frame layout (presentation only, should not affect the simulation): `vision` is a byte column
   (sim_frame.js SIM_FRAME_U8 / SIM_META_U8, sim_frame_world.js u8), slot bytes rounded up to 4.
4. Presentation: structures are published at the next tick for changed tiles (sim_presentation.js
   _simPresentStructureChanges, reads the tile journal tileEntityChangesSince with its own cursor). Read-only
   for the simulation, but check it does not consume or reorder anything the simulation relies on, and that
   SimSlots.slotOf (_simStructSlots) is not part of hashed state.
5. Info panel / UI (page only): hud.js selection compaction, sampled groups, background bins; should not touch
   the simulation.

How to find the first differing state: DIVTRACE=1 (net-harness.cjs; DIVTRACE=2 adds kernel movement state),
`H.divergenceReport(a, b, fromTick)`, and the `forced`/`repairs` lists in multiplayer-chaos-determinism's error.
Bisect against 6fcca4c by copying files into an export (`git archive 6fcca4c rng/defence3/src ...`), as done for
worker-walk: revert one changed file at a time.

Memory notes that apply: defence3-fix-every-divergence (fix desyncs at once, rule out harness flush first,
two-peer chaos checks), defence3-determinism-rules, defence3-profiling-pitfalls,
defence3-patch-scripts-safe-write.

## Test pitfalls hit this session

- The regression runner crashed twice writing its results file on the Z: drive (EUNKNOWN, a transient lock):
  run-regressions.cjs now retries the write.
- Several files are CRLF; Git Bash sed -i and naive patch scripts mixed line endings (one test then failed on a
  stray `\r`). Use the Edit tool or a script that keeps each file's endings.
- Do not edit src/ while the regression runs (~1.5 h for both modes at concurrency 3).

## Other open items (after robustness)

- Multiplayer latency under ping: tests/test-runs/probe_mp_latency.cjs (100 ms ping + 30 ms jitter: an order is
  taken on both peers ~280-320 ms after the click; units move ~300-350 ms). A client-side movement preview would
  hide most of it.
- Units start moving slowly when a million start at once (raw simulation cost).
- Close-range attack variety; bottom-bar scroll smoothness.
- Unit and probe tools from the session: .claude/panel_scroll_probe.cjs, .claude/zoom_ladder_probe.cjs,
  .claude/artifact_scenes_probe.cjs (scenes in tests/visual_artifacts_tests/), .claude/zoomout_probe.cjs
  (VARIANTS, SHOT).

## 2026-10-25 session: construction, drive-by, build bursts, marks, turrets (rules revision 37)

Changes (all uncommitted at the time of writing):

- **Building sites walkable**: a wall-type thing (towers, clouds) is a wall only once built
  (things_utils.js `structureWallSync`, called by `markConstructionComplete` and main.js starter buildings;
  placement no longer sets TYPE_WALL). Units on a tile that becomes a wall are pushed off at once
  (unit.js `_simWallPushOut` from `simMoveTileTypeChanged`; the old `simPassWallFixups` never fired: it ran
  before the deferred walls were applied). `canBuildAt` refuses a tile with a tile entity. The wall change is
  journaled (`noteTileEntityChanged`) so the laser beam map sees it. Tests/benches that finish towers by setting
  `underConstruction = false` now call `structureWallSync` too (tickbench, chaos, several tests).
- **Drive-by at structures**: moving shooters (acq flag 16) get the scan's structure (lib.rs acq_scan,
  acq_sample.rs exact + `area_answer`), the brain answers 16|4 when no unit is in reach (k.rs k_combat_brain),
  mv.rs `move_struct` fires and returns false (own move goes on). Priorities as the idle look: units, then
  turrets, traps, barracks/spawners, other buildings.
- **Mass placement TPS / page stalls**: page `pageApplyStructures` applies membership changes by slot
  (alive byte, typed mirror `_pageViewHas/_pageViewSer`), only changed tiles redrawn (background dirty rects
  list, minimap per-pixel repaint `minimapStaticTileChanged`), cell deltas journaled instead of
  `tileEntityIndexesReset`. Worker side: a bigger structure table is filled beside the shown one
  (`p.structuresNext`) and grown on demand (`_simStructTableGrow`); a tile whose structure went clears its slot
  at the next tick (`p.tileSlot`); floor items now go through the per-tick publish (they waited for the cycle).
  Edge probe `.claude/place_tps_probe.cjs` (100k-1000 fixture + 80k towers, 200 placements/s): page frames
  4-30/s -> 81-103/s, worst frame 150-400 ms -> 30-40 ms, placements accepted 430 -> 1440 in 10 s.
- **Sites drawn as the building** (no fade/lift/ghost pass), a hammer over each; salvage cross drawn over the
  structure on the overlay canvas (renderer3d `drawSiteMarks`, sprites shared with renderer2d); a salvage press
  shows its cross at once (`noteSalvageShown`), structure flag changes reach the page next tick
  (`simPresentTileDirty`, from processAction tiles and construction completion).
- **Turrets turn at far zoom**: live shared angle array per structure slot (`_simPresentAngles`,
  `simPresentTowerAngle` from tower.js), page table uses it, renderer3d re-uploads only the angle column on
  `angleRev` change.
- New test: tests/construction-walk-driveby.test.cjs. Probes: .claude/place_tps_probe.cjs,
  .claude/site_marks_probe.cjs. Bench: tests/test-runs/place-burst-20261025/run.sh.

Open from this session:
- worker-walk fails in worker mode (also on HEAD 7c1099e): a worker stuck short of its target when other
  workers are about; with only the collectors walking it passes. Being investigated.
- User report: a builder and a healer walking head-on jitter in place instead of passing. Not reproduced yet
  on open ground, in a one-tile lane, with worker-driven builders or at dk 4/10 (scratch headon.cjs);
  traffic_swap skips partners with mvWk != 0 (workers), a suspect.
