# Multiplayer robustness: progress

Goal (the user's, 2026-10-24): make the current version robust before any further optimization: fix every
nondeterminism, desync and error in multiplayer (and anything else the regression finds). Graphics and FPS are
good enough for now.

Start here: commit `7c1099e` ("3d fixes") holds all of the 2026-10-24 session's work (see "What changed").

**Update 2026-10-25:** all five below are resolved or no longer reproduce on the current (uncommitted) code: see
"Resolved later the same session" at the end.

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

Resolved later the same session:
- worker-walk (worker mode, also failed on 7c1099e): two collectors met in a one-unit pocket of the base's tower
  ring and pushed against each other for good: mv.rs traffic_swap skipped any partner with a worker task
  (mvWk != 0). Workers walking the other way now swap (standing workers at their job still keep their spot).
- Head-on builder/healer jitter: the user confirmed it is gone with the current code.
- Tower Range 0a in the info panel (worker mode): page views' currentStats/preComputed were a stub; they read
  the page's stat tables now, and the panel columns use preComputedBase / preComputedEffective (the card itself
  has no area range). The simulation always read the range from the tables (boosts included).
- load-world, worker-created-start, solo-snapshot (worker mode): test setup, not bugs: they inspect the
  simulation on the page, which SIM_WORKER=1 moved into a worker. Those instances are pinned to page mode
  (simWorker: false), and the harness now honours an explicit world.simWorker = false over SIM_WORKER
  (solo-snapshot runs both modes itself).
- multiplayer-chaos-determinism (worker mode): passes on the current code (5 runs, also under heavy load).
- multiplayer-extremes (worker mode): failed once ('exact after the patch', host vs guest4 from tick 847) in a run
  beside four other heavy tests; 15 runs since passed (plain, 3-5 heavy tests at once, EXT_GC=3/5 forced host GC
  plus per-peer heap poison, EXT_DK=2/4/10 forced step sizes). Not reproduced. On a failure the test now prints
  which state regions differ (cheap) and, with DIVTRACE=1, the first traced difference after the patch.
  Note: DIVTRACE itself changes timing (the failing run did not fail with it).

## Background run started 2026-10-25 03:09 (check results in the next session)

`tests/test-runs/full-20261025/run_all.sh`, started detached, one step at a time: full regression (both modes,
`tests/full-20261025.json`, summary in `regression-summary.txt`), other suites (crowd-scenarios, scale-world,
storage census, extremes with EXT_GC/EXT_DK, chaos with CHAOS_HOST_HELPERS), fuzzing (long soak both modes,
corruption/action fuzz, ui-fuzz, browser MP GUI fuzz, join stall), every tests/*.bench.cjs, tickbench modes
(benchall base/active/battle/towers/siege, memory/GC/CPU-per-kernel runs, RALLY10, B800, 200k and 4M scenes,
placement burst), CPU profiles (main + helpers) and a heap profile, then Edge probes (render TPS, render scale,
scene TPS + heap log, placement burst, site marks, UI long tasks, click/input latency, order marker, page stalls,
motion jitter, LOD, view switch, action spikes, panel scroll). Per step output: `tests/test-runs/full-20261025/<step>.txt`;
progress and exit codes: `status.txt`; script log: `run_all.log`. Nothing is committed yet.

### Results and fixes (2026-10-25)

`status.txt` showed exit=0 for every step: `step()` read `$?` after `$(date ...)` had reset it. Fixed (exit code
read first, `TIMEOUT` noted for 124); the step outputs were read instead. Failures found and fixed:
- **multiplayer-patch** (both modes; solar_system, seed 5212): a restored guest's `u173.effectiveStacks` differed
  11 ticks after the restore. Cause: the spatial index kept a stale tile for walking workers. Walker swaps
  (traffic_swap with walkers, added in the worker-walk fix) happen in the occupancy job's second pass, after the
  swapped partners' list (`swl`) was already drained, so the partner's new tile never reached the index (spTile,
  spArea, chunk key) until it crossed another tile. The host's effective-levels area snapshot (`_effAreaHist`)
  counted it in its old area; a restored guest rebuilt the index from positions. Fix: mv.rs, after the second
  pass, the epilogue once more for partners of the second pass's swaps whose tile changed (epi_slot's index
  update is a no-op for a slot already at its tile). Scratch probe (stale spTile between ticks) found 0 after.
- **multiplayer-snapshot** round 3 (both modes): a builder walking to a site that had been removed (in no list,
  not at its tile) keeps the object; the codec sends it as a pooled object (`~c`). `_snapDPool` made it with
  `Object.create(C.prototype)`, no structure table row (`_sr` undefined), so all its fields went to the tables'
  shared stray slot: the last such structure that peer decoded (another barrack at 13,20 on guest3). Fix:
  structures in `~c` get `_snapStructShell` (structTableInit), as listed ones do. New test
  tests/snapshot-pooled-structure.test.cjs (fails before: both targets read 13,20).
  (Still true: a worker keeps a removed target until it arrives; deterministic, now restored alike.)
- **attack-range-display**: the test faked the tower's stats through currentStats/baseStats, which the panel no
  longer reads first (preComputedBase/preComputedEffective since the 0a fix); the test fakes those too.
- Stale suites/benches: crowd-scenarios read the removed `mvSpd` column (now the stat row's rSpd);
  checkerboard-tps and crowd-front wrapped the removed `_forEachUnitInTickOrder` (missing phases skipped, as the
  other benches do); checkerboard-tps defaults to 2M units without memory64 (4M filled Node 22's 4 GiB heap);
  area-acquisition-sample used memory64 unconditionally (32-bit build when the runtime lacks it, as sim_wasm.js);
  active-scale's baseline commit 99a1e51 no longer exists (baseline = HEAD for timings; hashes compared among
  the current runs, and to the baseline only when DEFENCE_TEST_BASELINE is named); unit-id-index needs
  `--expose-gc` (run_all passes it to every bench); edge-action-spike ran without arguments (now
  `VIEW=3d 100000-1000.json eval:0x8`); the scale-world step removed (a library, not a test).
- Not failures, noted: Edge render-TPS crashed the tab at the end of 100000-1000 Team cases (two 100k peers on
  one machine, known 3-5 TPS); 50000-200 combat views 10 TPS; edge-lod one glError 1282 on its first case;
  join-stall counted desyncs repaired by patches (71 on one peer) with ~2.1 s long tasks at a spectator join.
