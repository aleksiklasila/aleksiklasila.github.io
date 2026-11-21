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

## 2026-10-27: checkerboard continuation and local input overflow

Continued the saved 50k checkerboard run after the status-expiry desync fix.
The previous run's final missing-command assertion was a separate problem:
some bursts contained 280-308 actions, above the host's 256-action packet cap.
The harness inserted them directly with queueAt, but the normal input queue
also allowed this overflow. The cap intentionally protects every peer against
floods; it remains unchanged.

- worker.js `_localActionTick` now selects a later unsent/unsealed tick when
  the local packet is full. Ordinary commands, split unit commands and reload
  requeues share this path. No shared simulation or protocol rules changed.
- `multiplayer-input-overflow.test.cjs` queues 513 ordinary and 257 preserved-ID
  reload commands from each of three peers (two teammates). All 2,310 must be
  delivered to every peer and applied exactly once, with matching state and no
  repairs. Removing only the fix fails the local packet-cap assertion; retained
  diagnostic: `tests/test-runs/multiplayer-checkerboard/input-overflow-before.log`.
- Checkerboard bursts now split at the actual transport cap, put shared-tile
  conflicts first, and drain the last packet plus simulation action backlog.
  `--teams=0,1,2,0` configures three distinct teams with two teammate clients;
  the fixture now builds/researches/orders armies for every configured team,
  distributes dense job districts across them, and checks all six job types
  per team. Population scaling uses actual team count.
- Added missing live-game commands, valid multiply/divide group modes, explicit
  handler-dispatch counters and assertions for all 30 live-game action kinds.
  Dispatch alone is not a successful effect: stale targets, losing placements
  and full queues remain expected. Real work counters remain separate.
- Added `tests/MULTIPLAYER_CHECKERBOARD.md` with commands and limits. Resign and
  host-only force-resign are covered by the dedicated lifecycle/authority fuzz
  suites; they are not injected into the middle of a continuing battle.

WASM32 results retained in `tests/test-runs/multiplayer-checkerboard/`:

- `continued-50k.json`: PASS, original two-team/three-peer scene with helpers
  7/0/3, 49,998 starting units, 20,000 requested structures, dk=20, 260 gameplay
  ticks plus delivery drain to tick 295. All 12,828 actions delivered; 570 exact
  peer/tick comparisons, 22 collision bursts, zero patches/desyncs. Final
  population 17,493; 8,287 spawns, 43,310 researcher deposits, 15,198 energy and
  11,416 astar deposits, 1,067 completions, 8,532 destroyed structures, 1,190
  placements, 10,089 healer deliveries, 1,756 salvage returns, 1,092 contested
  placement attempts. This compatibility run preceded the expanded 30-action
  counters and multi-team fixture changes.
- `three-teams-unstable.json`: PASS, four peers/helpers 3/0/1/2, teams 0/1/2/0,
  solar_system map, 11,994 starting units, 5,000 requested structures, dk=4,
  160 gameplay ticks, 13 bursts. All 30 live-game command handlers reached on
  every peer and no unplanned repair. Deliberate guest energy corruption then
  required exactly one targeted patch, no match-wide snapshot, and 200 exact
  comparisons over the following 64+ ticks with no repeated repair. This run
  preceded the final per-team district-distribution assertion.

These are correctness runs, not performance comparisons. State fingerprints
are checked at common ticks: final wall-clock samples can show different
populations because clients have completed different ticks under jitter.
The unstable network models reliable SCTP retransmission delay, not permanent
loss of reliable messages. Further current validation uses WASM32 only, per
the user's production-target clarification; no more legacy memory64 runs.

Additional WASM32 validation: `targeted-regressions.json` reports **10/10 PASS**
(serial, SIM_WORKER=0 and 1): multiplayer-action-fuzz, input-overflow,
late-carry-restore, reload-input and roles-rematch. This includes hostile
force-resign rejection, teammate/last-player resignation and rematch lifecycle
coverage. Input-overflow verifies every original and requeued command is
applied exactly once in both simulation modes. The packet limit stays 256.

Final production-target run: `four-teams-final32.json` **PASS**, WASM32,
helpers 3/0/1/2, four distinct teams 0/1/2/3, seed 999, islands 256, 18,004 actual
starting units and 8,000 requested structures, dk=4. Every team has each of the
six professions' job types (ownership uses a sub-district tile pattern, avoiding
a four-team correlation that would omit some professions). All 11,464 commands
were delivered, all 30 live-game handlers were reached on every peer, and
567 clean exact comparisons passed over 13 collision bursts plus backlog drain.
No unplanned patch or snapshot occurred. Forced guest corruption then needed
one targeted patch and passed 196 further exact comparisons over 64+ ticks,
with no repeat patch and exclusive occupancy on every peer. Host tick 312:
1,442 surviving units, 673 spawns, 6,031 research deposits, 445 energy / 215
astar deposits, 104 completions, 5,499 destroyed structures, 792 placements,
1,086 healer deliveries, 372 salvage returns and 642 contested placements.
Combat substantially thins this workload; it is not a sustained 18k population.
Clean and intentionally corrupted recovery windows are reported separately.

`focused-final32.json`: **3/3 PASS**: status-expiry-records (fire, poison, ice),
chaos-spikes-scenario (mixed/front structural and work-site checks) and
chaos-scenario-determinism (65 exact state hashes matching across two scalar
replays and one three-helper replay). Changed JavaScript syntax checks pass.
All validation after the user's target clarification used WASM32 only.

## 2026-11-18: static audit of hangs and unrecoverable desyncs, fixes

A source-only audit (four rounds, 23 findings) was checked against the code; all 23 hold and are fixed below
(one, a guest with the host's result still waiting for a tick, has no clear trigger: fixed defensively). Left as
is: the audit's note that automatic removal after a disconnect is ~11.6 days (`NET_HOST_AUTO_DROP_MS`), which is
intentional (the host's manual Drop button is the recovery). **None of this has been run yet**: only `node
--check` of the changed files. Validation (targeted reproductions + the MP regression suites) is the next step.

Simulation-thread hangs:
- sim_worker.js: a tick whose command preparation (`actionsPrepare`) threw was never queued, and a throw in a
  tick's pre-steps (history flush, presentation begin) skipped `currentTick++`: the worker refused every later
  tick, the page kept its link alive (a host looked connected and never advanced). Every step before the advance
  now reports its failure as the tick's (repair via `resyncNoteTickFailed`) and the tick still advances. A tick
  that arrives *ahead* of the worker (`ahead` flag) now counts as a worker lost (sim_client.js), which re-gets the
  match instead of stalling.
- sim_parallel.js: after a failed chunk or local task, the dispatching thread skipped the rest of its chunks
  (counted as done). A skipped occupancy block never published its marker, so a helper waiting on it, and the
  simulation thread waiting for the helper, hung. All chunks now run (as on helpers; first error rethrown), and
  the occupancy kernel publishes its marker however it ends (also on a missing kernel).
- sim_client.js / main.js: requests deferred while the worker ran ticks on its own were drained only before the
  page's `currentTick++`, so the last adoption never drained them, and the pending request blocked further
  autonomous ticks. `simClientFlushDeferred` now runs after each adopted tick.

Recovery, joins and the start:
- A guest's 8 s full-sync retry made a new join generation each time; the host discarded each finished snapshot
  as superseded. Repeats are ignored while that peer's join is in flight (`resyncHostJoinInFlight`; silence is
  still handled by `resyncHostCheckJoins`).
- Sim rule switches read from each page's URL (?occupancy, ?traffic*, ?acq) are now the host's: carried in
  `matchStartConfig.simRules`, adopted by guests (`netSimRulesApply`) and part of the config hash.
- A guest joining during the start's initialization marked its barrier done; the host still waited for its
  status. The host now exempts joiners (`_matchInit.exempt`). Initialization also ends after
  `MATCH_INIT_MAX_TICKS` (64): a periodic cost spike (an every-8th-tick lane commit) never passed the settled test.
- The warmup poll ended on any worker epoch change (a restore during warmup, e.g. a migration resync) and nothing
  restarted it: it now ends only with the match or the worker gone.
- A guest's normal start left `matchStartWaitingForReady` cleared by `startGame()`, stopping its loading
  heartbeat while its worker loaded (the host dropped it after 45 s). Set again after `startGame()`.
- A failed host start after START_GAME_PREPARE now sends START_GAME_CANCEL; guests leave the loading overlay.
- Live/paused joins with the worker: the page skips restoring a staged Q/E and the navigation state, and the
  worker started at the first tick from a snapshot of the page, without them. The worker now starts from the
  host's own join text (`simClientNoteJoinText`/`simClientTakeJoinText`, valid while no tick ran and no state was
  decoded since: `snapDecodeSeq`).
- Late-command carry (`lockstepHostCarryByPeer`) moves with a player's roster entry on a peer-id migration.
- `forceResignTeam` decisions use `hostTeamStillPlayed`: a teammate loading a join counts, a resigned host not.
- A held-order queue of a joining guest promoted to host is released (`resyncGuestReleaseOnPromotion`).
- A second guest-only tick failure within the 60 s repair interval is owed (`failOwed`) and requested later,
  unless a restore since replaced the state.
- TICK_RESEND_REQUEST carries the match tag (a previous match's request made far-future packets in a rematch); a
  request for a tick already run is stale (it crossed the sealed bundle) and no longer forces a full sync.

End of match:
- A guest whose own end the host has not confirmed now keeps its silent-host reconnect and migration checks.
- A full sync asked after the host's end (a reload after the final tick) is the final state now, with the result
  after it, not a join scheduled for a tick that never runs. A guest that has the host's result but no bundle to
  run next asks for the final state after 5 s.

Host migration:
- A handover acknowledgement after HOST_HANDOVER_MS is still accepted (from any peer handed to); a successor
  answers a retry of the same handover; a successor whose acknowledgement lost to another is told by HOST_MOVED
  and joins the winner (no two hosts).
- Two hosts that are each alone when a split heals: only the larger id demotes (`players` in HOST_SEEK_REPLY).
- Worker-loss handover falls back to linked spectators after the players.
- A reloaded former host searches for the match for `MATCH_RECORD_SEEK_MS` (~85 s), longer than a lone
  opponent's election wait (60 s + attempt), instead of six tries (~35 s).

Validation to do (suggested order): a host-worker tick that throws in preparation; a forced chunk failure in the
occupancy kernel with helpers; a full sync whose snapshot takes > 8 s; a guest reload during warmup; a live join
with a Q/E staged; a rematch with a delayed resend request; handover with the acknowledgement delayed > 4 s; then
the MP regression suites (worker and page modes).

## 2026-11-19: validating the 11-18 fixes; find / fix / test loop

**Harness bug (big): `SIM_WORKER=1` ran the page mode since 2026-10-25.** tests/net-harness.cjs `World` set
`this.simWorker = !!options.simWorker`, i.e. `false` when the test named no mode, and `createInstance` reads an
explicit `false` as "page mode, whatever SIM_WORKER says" (the 10-25 change for tests pinned to the page). So every
"worker mode" regression run since then tested the page twice, except tests that set `world.simWorker = true`
themselves. Fixed (unset stays `undefined`). Worker-only bugs of the last 3.5 weeks may surface now.

New tests (each fails on the code before its fix, checked in a scratch copy with the old files):
- `tests/multiplayer-worker-hang.test.cjs` (worker mode): a guest worker's command preparation throws once; a host
  worker's presentation begin throws once; a guest worker a tick behind its page. Old code: the worker refused every
  later tick (all three time out); now: the tick runs (failure repaired), resp. the page counts the worker lost and
  gets the match again; in sync after. Fourth case `handover-late`: the host's worker is lost with two guests, and
  both guests' HOST_HANDOVER_DONE arrive 6 s late (after HOST_HANDOVER_MS): one host in the end, in sync (pre-11-18
  code: the old host and guest2 both hosting). `ONLY=prepare|presentation|behind|handover-late`.
- `tests/occupancy-chunk-failure.test.cjs` (page mode, host with 3 real helper threads, 1800 units on a 64 map):
  the simulation thread's occupancy chunk throws (30 ms late, helpers hold later-phase blocks) on 6 ticks. Old
  sim_parallel.js: hangs (child-process timeout); now the match goes on and agrees.
- `tests/multiplayer-join-retry.test.cjs` (both modes):
  - slow: a guest asks for the whole match and the host's snapshot takes 20 s to encode each time; the guest's
    8 s repeats are ignored (2 here), one join is sent, joined after ~21 s. Old (pre-11-18): never joined.
  - failed: a reloaded player's first join does not decode. **New fix today:** the guest's request names the join
    it could not use (`failedJoin`, utils_networking.js `netGuestFailedJoin`, sent by main.js
    `requestHardLockstepResync`), and `resyncHostJoinInFlight` does not count that join, nor a join sent over
    another connection than the request's (a reconnect), as in flight. Before: the guest's own JOIN_LOADING notes
    kept the failed join "in flight" and the host ignored its requests until the 45 s silence check (45.4 s);
    now a new join comes at once (0.4 s).
  - warmup: the start's initialization never settles (`matchInitializationWorkSettled` forced false) and a guest
    reloads during it: released at `MATCH_INIT_MAX_TICKS`, the host does not wait for the joiner's barrier status,
    the guest joins, in sync. Pre-11-18 code: every peer stopped at tick 12 for good.
- `tests/multiplayer-sim-rules.test.cjs` (both modes): a guest page with other rule switches (occupancy off,
  traffic 0, exact acquisition) runs the host's (page and worker), in sync, no repair. Pre-11-18: the guest kept
  its own.

Also ran: `CHAOS_HOST_HELPERS=7` multiplayer-chaos-determinism (page, 6 maps): PASS, only the forced patches.

Worker mode for real (after the harness fix): `multiplayer-fairness` failed ("host commands wait the match delay
(4.17 of 5)"). Not a game bug: every command's delay equals the lead at the moment it was issued (host and guests
alike), counted from the completed tick the player sees (worker.js `_localActionTick` /
`netCompletedSimulationTick`); the harness recorded the page's `currentTick` (in worker mode ahead of the completed
tick) and the test compared with the lead at the end (the auto controller moves it 4 <-> 5 in worker mode). The
harness now records the game's reference tick, the test the lead at issue. PASS both modes.

**Worker-mode bug: the host's rematch never started** (`multiplayer-matrix` worker: "rematch started" false;
host error `k_rq_op: no wasm kernels on this thread` from `startGame` -> `researchQueueReset` -> `_rqAttach` ->
`researchTask` setter -> `_rqInsert`). Between matches `simClientActive()` is false, so data_dynamic.js
`_researchSimSide()` took the worker-mode page (no wasm kernels) for the simulation side: the reset made heap queues
and replayed the last match's plain research task through the kernel; the throw aborted the start
(`[STARTUP] Failed to start hosted game`). Fix: a page without `_simWasmX` is never the research queue's simulation
side, and a plain reset drops heap-queue accessors first. Matrix case 0 worker: PASS (rematch ok). Real games hit
this on every rematch with the (default) simulation worker once a player had research queued.

### A restore at scale changed the game (slot-layout dependence), 2026-11-19

Check: `tests/chaos-spikes.bench.cjs --units=131072 --worker-min=8000 --structures=60000 --ticks=100 --warmup=0
--helpers=4` with `--restore-at=30` (encode + decode + flush in place: a resync's restore, dense slot layout) vs
`--flush-at=30` (the flush alone: the unrestored peer), `--hash`, and `ROWX` = the lockstep hash parts per tick.
Before: final exact hashes differed (`890c7c2a` / `7decaed6`), first at tick 48 (players: player 1's astar off by one
movement charge, 4714.31), units from tick 51: a full resync at this size would have left the repaired peer
diverging. Traced (step-eval hooks in tests/test-runs/mp-validate-20261119/*.js: astarhook, scouthook, spenthook2,
unithook*, brainhook*):
1. **Area target batch by slot order.** With area targets (default), a unit's candidates are a batch of four at a
   seeded place in its target area's bucket (acq_sample.rs `area_batch`); the buckets kept the unit index's order
   (by slot within a cell). Another layout, other candidates, another target. Fix: new stage `k_acq_area_sort`
   (kernel 147, after the scatter): each bucket's entries in id order, LSD radix (8-bit passes, shared bytes
   skipped) through `acq.saE2`, buckets of <= 16 by insertion; jobs by key ranges (`P[38]`).
2. **The scan's unit target not following relayout/compaction.** Between an acquisition run's post and commit the
   online slot relayout (runs on a fragmented layout; a restored, dense one needs none) moves units; the replay
   (`k_acq_remap`) and the compaction (`acqTierRemapSlots`) remapped the brain's kept target (`acq.bt`) but not the
   scan's (`acq.out`), which `brain_pick` takes as the fallback when the kept target fell: it read the moved unit's old
   slot (empty) and refused the fallback the other peer took (scout 122291: kept 57771 dead, fallback 57767 moved
   62990 -> 13345 at tick 47). Fix: both remap `acq.out` as `acq.bt`.
3. (Found on the way, not the cause here: mv.rs `commit_step`, the scalar path, set the tile-step charge `spent` from
   the raw `x + vx`, the vector `step4` from the stored quantized, checked position; a unit's path depends on its
   4-slot group. Now from the stored position. Rules revision 58 for 1-3.)
4. **A restore left object fields in released slots.** After 1-2 the first difference moved to tick 77: a
   `laser_resistant` born into slot 110552 of the restored peer was a `workerType` "researcher" (hashed). Before the
   restore a researcher held that slot; `simUnitStateReleaseAll` (the restore's reset) zeroed the core and movement
   columns over the released slots but left the object fields (`oc_*`) and JavaScript fields, marking the slots `ever`
   so the JS spawn path (`_simUnitSlotStart`) resets them; the batch births (spr.rs `k_spawn_write`) never look at
   `ever` and write `workerType` for workers only. Fix: the reset clears those columns over the range
   (`_simUnitFieldsClearRange`, a column at a time: shared/num columns `fill`, reference pages dropped).

After 1-4: **restore and flush identical** (exact hash `a18cafb5` both, every tick's hash parts equal over 100
ticks; raw `tests/test-runs/mp-validate-20261119/i131-*.json(l)`). The restore itself took ~18 s for 105k units
(encode + decode + flush, outside the timing): a resync of that size freezes the restoring peer. Split
(`RESTORE_SPLIT=1`, under some concurrent load): encode 3.6 s, decode 6.0 s, flush 0.3 s. CPU profile of the restore
(`--profile --profile-start=30`, `tests/test-runs/mp-validate-20261119/rprof.json.cpuprofile`): no single owner; the
time is per-unit JavaScript (snapDecodeState, _snapRootRef, simUnitStateKeys, accessors get/set, _simUnitObjInit,
_snapEObj, _sTableKeys, simMoveStatsChanged, simPathStore, Unit construction, GC). Next big item: unit (and
structure) state as columns in a binary snapshot encoded/decoded by wasm kernels, not per-object JSON.

Remaining worker-mode failures from the run, after reruns on the current code: fairness, result-authority, matrix,
soak PASS (the rematch fix; result-authority/patch had also met mid-run wasm rebuilds). `multiplayer-patch` (worker,
islands seed 5181) failed reproducibly: test artefact. Its forced full patch moved `units.find(!dead)` 5 px by hand;
that unit (id 1, standing) was put back on its footprint before the next hashed tick, and the test's fallback
`players[1].energy += 17` is overwritten by the fixed-point resource values: no divergence, nothing to patch. Now
`addPlayerResource(1, 'energy', 17)`: PASS. (Detection itself was fine: the guest kept comparing.)
`multiplayer-patch` both modes: PASS.

Worker mode for every other test file (first real worker run since 10-25), `all-worker.json`: 241/246. The five:
event-route-batch, math-portability, starting-spawn-limits, zero-resource-config drive the simulation on the page
itself (page-only setup, pass in page mode): pinned with `simWorker: false`. tier-phase-schedule failed in both
modes, also on HEAD (scratch `git archive HEAD`): a stale expectation, the worker search commits only when its post
found due workers (3 of 12 cycles in its small match); the test needs >= 2 commits now (it checks the tiers' ticks
apart). All five PASS in worker mode now.

More restore-vs-flush variants (131k): `--dk=4` identical over 80 ticks. `--layout=front` (sustained battle near a
full population): two problems, both fixed:
5. **Births refused with free slots left.** 24 barracks (row 393) had 20 queued on the unrestored peer, 19 on the
   restored one at tick 31: their births failed on the fragmented layout. nfs.rs `slab_alloc` looked at other slabs'
   holes only above a slack threshold of free slots, then empty slabs, then a fresh slab; with every slot of the
   reservation opened the fresh slab failed and the birth was refused (-1) although free slots remained. Now, with
   no fresh slab left, any free slot (`slab_near_hole`, then `slab_any`: the first opened slab with room). A birth
   fails only when no slot is free.
6. **A restore grew the unit columns past the match-start reservation** (147456 -> 151552 slots at 124k units; the
   bench's "unit columns must stay within their match-start reservation" assert): the decode reserved
   `max(population slots, rows * 1.125)`, the compaction `max(live * 1.125, population slots)`. Both now stop at the
   population's slots when the match has a population (1/8 more only without one).
   (5 was found chasing the front layout's barracks difference at tick 31, which turned out to be the bench, not
   the game: tests/chaos-spikes-scenario.cjs made the front's commands from barrack objects kept since the setup
   (`__scratch.chaosFrontBuildings`); after `--restore-at` those were stale objects (stale queues, and destroyed
   ones still "alive"), so the restored run sent other commands. The front's buildings are now found by tile, gone
   when none stands there.)
   After 5-6 and the bench fix: `--layout=front` restore and flush identical over 80 ticks (exact `7c531106` both),
   with the population at its cap (131072) from tick ~70. So: mixed, dk 4 and front all identical.
   Full regression after 5-6 (both modes): 582/582 PASS (`full-final.json`).

At-scale multi-peer checks: `.claude/tickbench.cjs` two peers (host 7 helpers, guest none) on chaos-mixed-600:
0 desyncs / 0 patches over 600-800 ticks at 82k units (its old setup no longer places buildings: combat and movement
only). `tests/multiplayer-checkerboard-chaos.cjs` large (50k units, 20000 structures, helpers 7/0/3, dk 20): PASS,
570 exact comparisons, all 30 actions, no repair. Four teams (18k, 8000 structures, helpers 3/0/1/2, islands,
unstable network, `--recover`): **FAIL, also on HEAD (pre-existing)**: after the forced repair (guest1's unit 6
energy -123) the targeted patch at tick 249 did not hold: guest1 differs from the host from tick 256 and needs a
second patch at 280 ("repaired checkerboard stays in sync: tickHashes"). Investigating (DIVTRACE from 245).
   **Cause (a repair flaw, not new):** the corrupted unit 6 (a tank, ~3.7 px a tick) differed from ~tick 210; the
   host compared the guest's hashes of ticks 219-239 and found the region where unit 6 stood around tick 220
   (tiles 124-127, 100-103). A patch carries the units standing in the differing regions *at the patch's tick* (249),
   plus one ring (`snapBucketsFromCodes` dilate 1); by then unit 6 was three regions on (rows 112-115), so the patch
   left it out and the guest asked again (tick 274, patch 280). Any unit that moves more than a region between the
   hashed tick and the patch escapes its repair; fast armies could keep escaping until the escalation to full
   patches. (Traces: host vs guest1 with guests 2/3 as the noise baseline: only `u6` field 5 (energy 1490/1367).)
   **Fix:** the host keeps the earliest differing hashed tick (`pending.oldest`), the patch's buckets carry their age
   (`ageTicks` = T - oldest), and the encoder (snapEncodeState `_snapWidenForAge`) widens the regions by
   ceil(2 * fastest stat-row speed * age / region px) more rings; the widened list is what the patch carries
   (`out.regions`), so the guest decodes membership over the same regions. After: four teams `--recover` PASS
   ("large-scene repair", one patch, 196 exact comparisons after it).

Final state of the session's code (rules revision 58, wasm hash 5fcc6b0a; after 5-6: cebdfaf4): all non-multiplayer test files PASS in
page mode (246/246, `all-page.json`) and worker mode; the multiplayer suites plus the new tests PASS in both modes
(96/96, `mp-final.json`); the 131k restore equals the unrestored peer. Nothing committed. Next: RESTORE_WASM_PLAN.md
(the ~10 s restore at 105k units).

### 2026-11-19 evening: restore units as a wasm column block (RESTORE_WASM_PLAN.md), in progress

- After the age widening: MP suites 96/96 both modes (`mp-widen.json`); three-team checkerboard `--recover` PASS (page).
  Worker-mode checkerboard surfaced test-only issues (never ran in worker mode before the harness fix): realm-foreign
  arrays (`[...errors]`), the page's burst used `findNearestWalkable` (no kernels on a worker-mode page: ring search
  `nearWalk` in chaos-spikes-scenario.cjs), occupancy audit on the page (now `evalSim`). Worker reruns not done yet.
- New: SNAP_FORMAT 8. Units travel as `S.ub` (utils_snapblock.js + wasm/src/snap_units.rs): raw state columns in id
  order (worker / status records, paths once, type names and shared pools remapped), base64. Decode: births kernel
  (slots by block, handles, records, id table + hash), scatter, paths, target slots; post passes as kernels
  (k_unit_stats_apply for rows + movement, k_spawn_spatial, spatial out). Partial patches: region select, order runs,
  drop by order (k_ub_drop + DetachGoneMany), id-table merge, reservations as raw (slot, id). Flush's
  simMoveRefreshAllStats now the kernel. `_astarBudgetBlockedUntil` a column (abBlk); dead role fields removed.
- Checked: restore-vs-flush identical at 16k (`23553147`) and 131k (`ea778fe7`, 50 ticks after). 131k restore
  10 s -> 4.4 s (encode 4.8 -> 1.3 s, decode 8.6 -> 3.2 s, flush 0.3 s -> 36 ms). Wasm hash 99800b45.
- NOT yet run: MP suites / partial patches with the block (the partial path is untested!), worker-mode checkerboards.
- Next (kernels written in snap_units.rs, JS not wired): k_ub_release_all (simUnitStateReleaseAll's per-unit detach,
  358 ms: pools reset wholesale, uix emptied instead of unitSlotMapInvalidate), k_pp_reset (resetPendingPathUnits
  walks every unit object, 240 ms). Then structures (~1.5 s of encode+decode), nav restore, simMatchPrepare.

### 2026-11-20: unit block through the MP suites

Runs on the block (`tests/test-runs/mp-validate-20261119/mp-ub*.json`) found, fixed:
- **Encode on a worker-mode page.** A page beside a simulation worker builds snapshots too (a test reads the carried
  commands from one). It has no unit state or kernels, so building the unit block crashed. Its snapshots now leave
  units out (`simless` -> `noUnits`), as the worker's own page snapshots already do; the worker's text carries
  them. `late-carry-restore` PASS in worker mode.
- **Leftover unit slots after a patch.** A unit taken out of the units list without its slot stayed alive in the
  columns. The old patch path collected such slots (simUnitStateCollect), the block path did not: another repair
  followed. snap_units.rs `k_ub_ghosts` marks the slots the id table holds (judged by the table, the real list,
  not the hash) and lists the live slots it does not; they go through the same release as units the sender lacks
  (`_snapUnitsRelease`, factored out of drop-by-order). Both marker kernels assume a zeroed scratch array on first
  use, so `_ubArr` zero-fills new arrays. Corruption pair `unitGone`/`unitExtra`: one patch each.
- Third run (`mp-ub3.json`): 107/111; the four worker-mode files left (ui-fuzz, worker-hang, stale-loading, soak)
  had all hung together for ~2.5 h with no output (normally 1-6 min each): a stalled sitting, not the code.
  Rerun alone (`tests/test-runs/mp-validate-20261120/`): worker-hang PASS; ui-fuzz, stale-loading, soak PASS
  (`rerun3.json`). So the MP + snapshot suites pass in both modes on the block.
- Checkerboard on the block: four teams (18k, 8000 structures, helpers 3/0/1/2, islands, unstable, `--recover`)
  PASS in page mode (556 clean exact comparisons, one patch, 195 after) and, for the first time, **worker mode**
  (558 clean, one patch, 195 after; ~40 min). Test fix: its `--recover` corrupted the page's frame copy of the
  unit in worker mode (no desync, the repair never came): `evalSim` now.

### 2026-11-20: validating the 11-18 audit rows (MULTIPLAYER_AUDIT_2026-10-15.md 55-77)

Rows 55-59 and 69 had tests since 11-19 (table now says so). New tests, each failing on 7aedaabd (the commit before
the 11-18 fixes; scratch copy of its src + index.html with the current tests and harness), passing now:
- `multiplayer-live-join-worker` (63, worker): a guest reloads the playing match three times. 7aedaabd: diverged
  right after the join (tick 80); now in sync, no repair. (q / e itself is off: UNIT_RESIZE_ENABLED false; the
  navigation state is what the page-started worker lacked.)
- `multiplayer-resend-request` (67, both modes): `stale` (a resend request for ticks already run: 7aedaabd reloaded
  the match) and `other-match` (a previous match's request for tick +400: 7aedaabd's next command never ran within
  6 s; now 200 ms).
- `multiplayer-slow-worker-start` (65, worker): guest1's worker reports its start 55 s late. 7aedaabd: dropped,
  its team resigned; now kept, in sync.
- `multiplayer-start-warmup` (60, 72, both modes): `join` (a reload during the initialization: 7aedaabd froze);
  `migration-back` / `migration-drop` (the host lost during the initialization; the old host comes back / is
  dropped). **New bug found (row 78, page mode too):** the new host's barrier waited for the lost host's status,
  which never comes (it is still a player until back or dropped), so the start stood even after the old host came
  back or was dropped; and its `allowed` was a guest's (the start tick), so every status was dropped as ahead (only
  the migration's resync, while the guests counted as joining, let it past). Fixes: `_matchInitializationPoll` skips
  players with no link (back, they join: exempt); `matchInitializationOnPromotion` (host migration's promote) grants
  from the tick it completed. Checked: without the skip both migration cases fail on the current code.
- `multiplayer-stale-loading` parts 61 (a false victory, then the host goes *silent*: 7aedaabd froze at the end,
  0 reconnect attempts) and 62 (a reload after the host's end: 7aedaabd never loaded it; now the final state at the
  end's tick, same winner). (The reloaded peer's `resyncGuest.joining` stays set after a final join, no tick to catch
  up on: it only holds commands, cleared by the next match's resetWorldState.)
- `multiplayer-promoted-joiner` (77, both modes): a joiner whose JOIN_LIVE goes unanswered, the first successor,
  holds a move; the host is lost, it takes over, drops the old host: the move runs on both, in sync. 7aedaabd: held.
- `multiplayer-handover-spectator` (73, worker): guest2 resigned (spectates), guest1 lost, then the host's worker:
  the spectator takes the match (7aedaabd: nobody asked, frozen), drops guest1, the match ends with the host's win
  on both. (While the match waits for a lost player, the old host's own rejoin waits too: scheduled for a tick.)
- More, the same way: `multiplayer-stale-loading` parts 64 (a removed player's teammate loading a join: 7aedaabd
  resigned the team; a resigned host's teammate removed: the team resigns, the match ends), 75 (a host start failing
  after its prepare: 7aedaabd left the guests on "Waiting for host to generate world"), 70 (a guest with the host's
  result but every bundle dropped: ends with the final state; passes on 7aedaabd too, kept as a regression test);
  `multiplayer-tick-failure` part 3 (74: the second failure inside the 60 s interval is repaired after it; never on
  7aedaabd); `multiplayer-reload-seek` (76: a 1v1 host crashes and reloads, back 63 s later as the guest took over;
  7aedaabd: "Could not find that game"); `multiplayer-carry-new-peer-id` (66: a carried late command, the guest back
  under a new id: runs; 7aedaabd: stuck under the old id. Its link is cut first, or in-flight old-id packets take
  the carry); `multiplayer-split-heal` (71: after a 1v1 split both host alone; healed with crossing probes: one
  host, the smaller id; 7aedaabd kept the larger one, the both-demote race itself not reproduced).
- Full MP + snapshot suites, both modes, with everything above (`mp-full.json`): 133/134; the one failure was a race
  in the new part 75 itself (the injected failure rejected at once: prepare and cancel within one poll), since fixed
  (it rejects after 2 s, as a world build takes time).
- Left: row 68 (needs a page stall: the worker ticks alone once the page beat is >40 ms stale; the Node harness
  cannot make one).

Audit while the tests ran (message handlers, per-tick maps, patch failure paths, end of match):
- **Row 79, fixed:** PLAYER_REMOVED_FROM_MATCH had no match tag; one late past a rematch's start marked that peer
  removed in the new match on a guest, and the guest itself went to spectating. All three senders tag it (`m`), the
  guest drops another match's (`netMatchTagOk`). Test: stale-loading part 79 (7aedaabd: spectating).
- **Row 80, fixed (user's call: rejoin as a player):** REQUEST_SPECTATE from a player of the running match (a
  reloaded player clicking Spectate in the lobby before its rejoin) set its role to spectating by peer and uid
  without the resign check the other "stop playing" paths make: its team neither played nor resigned, and the uid
  could not rejoin as a player. Now one rule, `hostRejoinRole` (utils_networking.js), for the lobby join and the
  request: a member of the match comes back with its role, a player as a player unless its team is out meanwhile
  (defeated, resigned: spectating); a player asking to spectate gets the match as a player (ignored while its join
  is on its way); the page shows no Spectate button to a player of the match (`remoteRoleByPeerId[myPeerId]`). It
  resigns the usual way if it wants out. Test: stale-loading part 80 (reload with a slow decode: no button, a forced
  request changes nothing, back as a player, then resigns; a defeated player reloads: back spectating). 7aedaabd:
  the button showed, and with that check removed the request made it a spectator. Join / reload / role / lobby /
  recovery files, both modes, after it (`row80.json`): 30/30 PASS.
- Checked, fine: TICK_PACKET (no sender left), TICK_UNAVAILABLE untagged (only reachable from a request for a tick
  past the host's history), JOIN_LIVE_ACK without the join number (a stale one only releases held commands early,
  and the host carries a joining peer's late packets), per-tick maps (cleared as each tick runs, adopted worker
  ticks too; `lockstepBundleAckByTick`, `lockstepHostHardResyncRequestedByTick`, `lockstepLastFinalizeSentAtByTick`
  are dead state), a patch that fails to decode (bounded wait, then asked again), `gameTime` units in the result
  review (base ticks).
- After row 79: removal / migration / rematch files and every new test, both modes (`final.json`): 36/36 PASS.
  Nothing committed.

### 2026-11-20 afternoon: stuck recoveries (audit rows 81-99)

Three pasted audits (another session's, harness fault injection, every page linked) and two limits from a navigation
session. Each finding is a row of MULTIPLAYER_AUDIT_2026-10-15.md (81-99) and a part of the new
`tests/multiplayer-stuck-recovery.test.cjs` (ONLY=<row>, MODES=page,worker): the part makes the fault, then requires
every surviving peer to advance, agree (H.checkHealthy over the ticks after) and run the commands issued after it.
Each part fails on HEAD 40a54e18 (`DEFENCE_TEST_BASELINE=HEAD`, the harness reads the old sources from git; logs in
`tests/test-runs/mp-stuck-20261120/baseline-*.log`) at its own assertion, and passes now.

- **Tick completion (81).** A throw while a worker published a tick's result left the page counting it in flight for
  good, and a guest's patch (gated on nothing in flight) never applied. Every tick that ran now ends in one result
  (sim_worker.js `_simPostBareResult`: no world, the failure reported with its tick, the next frame whole), and the
  page retires dispatched ticks older than any result (results come in order).
- **A worker that stops without a word (82).** The page waits for a slow worker by design (no silence timeout: a 2M
  world's first ticks take long). The evidence now is the peers': once a peer's report says it completed the oldest
  tick this worker has had in flight, and 20 s more pass without its result, the worker is lost
  (sim_client.js `simClientStallCheck`, from the pump): a host hands the match on, a guest gets it again. A helper
  gone from a parallel job's barrier ends there too (the worker and its helpers are replaced).
- **Every simulation lost (83).** New `src/utils/utils_checkpoint.js`: every peer keeps the newest whole state of the
  match it has as text (the start's, a join's sent or got, a match-wide resync's; the same string, no copy) and the
  commands of every tick since (only ticks with commands or a flush; step sizes as runs). A host whose handover
  finds nobody (a guest whose own simulation is lost now refuses at once: HOST_HANDOVER_REFUSED) restores it into a
  new worker and runs the ticks since again as catch-up (`netCheckpointReplayCatchUp` in the pump); the guests get
  the match from it as after any loss. Cost: the retained text (one string per peer on the page's heap) and a
  reference per busy tick. Left: no periodic checkpoint (a snapshot encode in play is a hitch), so the replay after
  a total loss is as long as the time since the last whole state (the start, or the last join / resync).
- **Escalation (84).** A request naming any part the last one named (players, globals, orders too) counts as a patch
  that did not hold, also past the 60-tick window: full patches, then the reload (`_resyncCodesRecur`). The test's
  constant drift (3 energy a tick for 20 s) got 13 full patches and a reload; before, partial patches only.
- **Page-mode double step (85).** What follows gameTick in runOneTick fails alone (stats, shadow, hash).
- **Start and migration (86-91).** A guest promoted during the start's wait takes it over (`hostTakeOverStartWait`:
  every linked player expected again, deadlines armed); the start's beat repeats START_GAME_READY once loaded (88,
  and the new host of 86 hears it); a guest that found its state diverged and is not repaired defers in a migration
  like one with an unconfirmed end (`resyncGuestStateSuspect`, `_migrationSelfDefers`); every start-text failure
  ends in startFailed before START_GAME (cancel sent, the host's own match ended); a host whose peer closed for good
  joins the first successor as a migrating player (`hostAfterPeerClosed`); a live join whose restore threw stops its
  beat and asks again at once naming the failed join, also from a page with no match yet (`_guestAskAfterFailedJoin`).
- **Snapshots in flight and the end (92-98).** A join's silence counts from its sending (`sentAt`; one that fails to
  encode or loses its link is dropped); a final state takes its match and result when it is made and is not sent
  into another match; one final state per peer answers repeats (`_resyncHostFinals`) and a guest does not ask while
  loading; joins scheduled past the end go as the final state at the end; a request past the host's last tick brings
  the result again; a hidden guest's pump keeps reviewing its end; MATCH_RESULT carries the host's hash of its end's
  tick (sent once that tick's hash is recorded; the end's tick is always hashed), and a guest confirms only when its
  own agrees or it has the host's final state.
- **Navigation substitutes (99).** The room was the list's and the table's (three quarters full), and the table's
  count differs between peers (a restored one holds only the waiting units'): past about half the population asking
  in one tick, peers refused different asks. The room is now a tick's asks, counted alike everywhere (found or not:
  pp.rs `sub_ask`, flownav.js `navSubstituteRequest`); the table cannot fill (a quarter full at a tick's start, the
  room's entries a half more); a refused unit asks again next tick and reads nothing meanwhile (`sub_asked`,
  `_navSubAsk`). Wasm rebuilt (hash 2002e086). No test: it needs about half of a large population asking at once.
- **Not done:** node field requests through JavaScript on builds without the routing atlas (pathfinding.js after
  k_pp_due; only NAV_ATLAS=false tests and empty maps have no atlas). The right fix is removing the non-atlas field
  pools (about 100 references in flownav.js, two tests that switch the atlas off), not a wasm copy of a fallback.
  Settings that still stop a match on purpose: Exact Lockstep Debug, and a disconnected player is waited for until
  back or dropped (the host's Drop button; the automatic drop is days away), as before.

- **Row 100 (found validating):** a join scheduled before a match-wide pause and sent after it carried a lower
  recovery number than the pause, and the guest dropped it; HEAD hid it by resending 45 s after scheduling, the
  row-92 change (silence from the sending) exposed it in multiplayer-worker-hang handover-late. Joins are numbered
  when made.

Results: the new file passes in both modes (30 parts, `tests/test-runs/mp-stuck-20261120/full-both.log`); each part fails on HEAD (`baseline-page.log`, `baseline-worker.log`; 92 checked again after tightening). Regression set (multiplayer, snapshot, navigation files, both modes, `regress.json`): 160 runs, one failure (multiplayer-worker-hang handover-late in the first mode: row 100, fixed); then the join, migration, reload, recovery, patch and snapshot files with the new one, both modes, on the final code (`rerun.json`): 50/50 PASS. Nothing committed.

### 2026-11-20 evening: three more pasted audits (rows 101-119)

Another pasted audit (fault injection in the harness). Each finding is a row of MULTIPLAYER_AUDIT_2026-10-15.md and a
part of `tests/multiplayer-stuck-recovery.test.cjs` (ONLY=<row>; `tests/test-runs/mp-audit-101/run-parts.sh <label>`
runs each part alone in both modes, logs beside it).

- **101 Handover to a diverged guest.** The worker-loss handover (`guestTakeHandedOverMatch`) skipped the suspect check
  an ordinary migration makes. A guest that knows its state diverged (`_migrationSelfDefers`) now refuses with
  `suspect: 1`; the host asks the next player, then runs the match from its own checkpoint, and only without one
  asks the diverged players again with `force` (their state, as before, rather than no match).
- **102 Late countdown.** A guest's countdown never hides the overlay (ALL_READY does), and bundles cleared only the
  wait flag: a countdown after ALL_READY covered the match for good. `guestReleaseMatchStart` (ALL_READY or the
  host's first bundle) stops the countdown, hides the overlay and marks the start released; a countdown of a
  released start is dropped.
- **103 Join older than a recovery.** `_guestStartCurrent` checked only for a newer join: a join whose decode outlasted
  a match-wide recovery restored its older tick over it. A join is stale once a newer recovery number is seen
  (its beat stops with it); the host retires a join older than the recovery the joiner acknowledged
  (`_markHostResyncAck`), so it is not sent again 45 s on. Validating found more: `applyIncomingMatchSyncPayload`
  reset the page's lockstep state and applied the start's config (`cfg`: Max Population as picked in the menu, 131072,
  while the match runs 1024) *before* its decode, so a join that turned stale left them on the running match; the
  next recovery's config hash differed and asked for another join. Those resets and the config now come after the
  decode's staleness check (the beat, the overlay and the session id stay before it), and a dropped join takes its
  "Joining Match" cover down unless a newer load or recovery holds it.
- **104 End hash partial.** Row 98's end hash was the rotating slice: `snapRecordTickHash` hashes every slice on the
  tick the match ends (page and worker record through it). One full hash per match. Validating found (worker mode):
  a guest's final-state repair reached only the page; its worker takes a join's text at the next tick, and after
  the end none runs, so the worker kept no world and the page (units from the worker's frames) showed the end with
  no units. A final state now starts the worker from the host's text at once.
- **105 Rematch roster after migration.** START_GAME and every join carry the start players as [peer id, uid] (`sp`,
  `hostMatchStartPlayersWire`); a successor maps them to current peer ids (`guestMatchStartPlayerIds`) instead of
  those playing at the migration.
- **106 Spectator restore failure.** The START_SPECTATE catch does what the player's does (`_guestJoinApplyFailed`:
  beat stopped, failed join named, asked again).

Then a second pasted audit the same evening (rows 107-112), parts of the same test file:
- **107 Failed join snapshot.** A join whose snapshot failed (the worker's text rejected, an encode failing) was only
  dropped: the reloaded player had no match to ask from, and the host, the join gone, waited for its input (tick 35
  for good). A page build that threw left the join counted as on its way for good. The build is inside the failure
  path now, and a failure makes the join (or final state) again after 1 s unless another is on its way.
- **108 Late patch request.** A patch request older than a guest's join replaced the scheduled join while the join
  record stayed; every later request was taken for a repeat. A patch request for a peer with a join pending or on its
  way is now moot; a join whose tick the host pump missed is made again rather than left counted.
- **109 Checkpoint from a recovery.** `_guestReceiveSnapshot` notes the restored match-wide snapshot as the guest's
  checkpoint (the skipped ticks had cleared the old one, so a successor whose worker was lost could not run the match
  again).
- **110 Order before the snapshot's tick.** A guest's commands for ticks before a snapshot that have not run and are
  in no bundle it has go back into the input after the restore, with their ids (the host drops copies it had).
- **111 Late RESYNC_NO_MATCH.** Only a reply to the pause running now counts, and not from a peer sent the match since
  that pause began (`_hostPeerGotMatchGen`); JOIN_APPLIED marks the peer as having the match.
- **112 Request of the last match.** Every REQUEST_MATCH_SYNC carries its match (`m`); the host drops one of another
  match from a peer already in this one (its packets of this match, or ready for its start). A peer still in the old
  match is answered as before.
- Test notes: part 105's resign is taken out of the command accounting (its role change resigns the team first, the
  command then has nothing to do and never counts as run); `assertAllCommandsExecuted` now names each lost command's
  issue time and tick. Part 110 places its order at a tick before the snapshot's (the harness's guests do not lag
  20 ticks as the audit's did).

A third pasted audit (rows 113-119), parts of the same file:
- **113 Successor without a simulation.** `_migrationSelfDefers` also covers a lost simulation: such a guest redirects
  to the next successor and takes over only when nobody else can.
- **114 Every worker silent at once.** `simClientStallCheck` also takes the worker's own shared progress as evidence:
  the control block says it ran the oldest tick in flight and the result never came; 20 s on it is lost. Still no
  silence timeout (the user's rule): a tick that is still running gives no evidence, and without shared memory only
  peers' reports count. The harness runs this part with SIM_SHARED=1 (the browser has cross-origin isolation).
- **115 Guest setup failure at the start.** A match start's apply that fails runs again a second later while it is
  still this page's start (it had asked a repair that a page without a running match never sends).
- **116 Cancelled start's late prepare.** A cancel marks its start ended even before its prepare arrives, and prepares
  and starts carry the host page's increasing start number (`_hostStartSeq`, per host page); an older one after a
  newer one is dropped.
- **117 Sealed, unrun host order.** A host handing over carries its own commands from the bundles after its lost
  worker's last result (`_simClientLost.appliedTick`) into its rejoin, with their ids; the successor drops any it ran.
- **118 Lone start after the peer closed.** After the renderer preparation, no peer or no other start player linked:
  the start fails back to the lobby.
- **119 Three-player split heal.** Both hosts apply one order: more linked players stays, a tie goes to the smaller id.
- **Found validating 114:** the worker took its shared control block with `msg.ctl instanceof Int32Array`, false
  across the Node harness's contexts: in SIM_SHARED=1 harness runs the worker never published its progress there
  (a silently disabled path; browsers were not affected, their clone is the worker's own type). Now checked by its
  tag. The harness also hands the worker's block to the page only with the worker's messages (modelling worker
  time), so part 114 mirrors it every step, as a browser's shared memory shows it.

Validation (rows 101-119): each part fails on the code with only that row's fix reverted and passes on the current
code, both modes where it applies. Baseline method: `make-baseline.cjs` (scratch, not kept) copies the touched files
and reverts each fix by pattern; the harness loads them through `DEFENCE_TEST_SOURCE_OVERRIDES` (file -> path), the
tree untouched. Logs: `tests/test-runs/mp-audit-101/` (`new*-<row>-<mode>.log`, `baseline*-<row>-<mode>.log`).
Tests needing more than the obvious: 105 (the resign command is not counted), 108 (the late request lands the tick
the join is due: one tick earlier the old code merged it), 116 (the held prepare goes right behind the retry's: the
harness's start text follows within 8 ms), 119 (the group host must have missed the old one for
HOST_SEEK_AFTER_MISSING_MS before the heal, or it never probes).

Regression (multiplayer, snapshot, resync, load-world, worker-created files, both modes, `tests/test-runs/mp-audit-101/regress.json`): 116/118; the two failures were multiplayer-stuck-recovery run whole, a V8 heap OOM at 4 GB (45 parts in one process, the harness has no world teardown). The file now runs each part in its own process when no ONLY is given; whole, both modes (`stuck-full.json`): PASS (96 part runs). Nothing committed.

### 2026-11-21: structures' stacks; a pasted batch audit (rows 120-128)

Structure work first (gameplay, multiplayer-visible): a build order's `count` is the stacks it orders up to
(`stackThingUpTo`), not that many more; `place` counts are no longer clamped to `ACTION_MAX_COUNT` (100: an L17 order
was 100 stacks); a new **Manual stacking** match setting (off by default, sent with the match config, enforced in
`processAction` on every peer). The adjacency flood was not seeded by a construction finishing or a cloud portal
joining/leaving (the far end), so groups' sizes and effective levels stayed stale until a change near them; page rows
refresh on stack orders and on the apply kernel's level changes. Tests: `structure-stack-target`,
`structure-adjacency-events` (the lane against the full JavaScript recompute after each kind of change),
`manual-stacking-setting` (also: a guest's own menu does not override the host's setting, page and worker).
`multiplayer-concurrency` expects 2 stacks from orders of 1 and 2 (was 3). The harness turns manual stacking on
by default (the old tests and workloads order stacks).

Then the pasted audit (another session's fault injection; "every surviving player advances, peers agree, an order
issued before recovery still has its effect"), plus one found here. Each is a row of MULTIPLAYER_AUDIT_2026-10-15.md
and a part of `tests/multiplayer-stuck-recovery.test.cjs`, reproduced failing first (the audit's numbers came back:
row 124's Hold issued at 20 ran at 247 without the fix), then passing in both modes where it applies:
- **120** orders under the start's loading overlay were dropped: held and queued at the release.
- **121** a successor waiting for the whole match took over and rolled the match back: it defers
  (`_migrationAwaitingWholeMatch`), as diverged or simulation-less guests do. Part 121 also checks the order survives.
- **122** worker lost after the link closed: the recovery loop survives the reconnect; no soft resume offered.
- **123** start apply failing after the world reset: the retry no longer needs the cleared match id.
- **124** stale JOIN_LIVE_ACK: carries the join's number and match.
- **125** held command lost by a failed apply: carried commands kept aside per match until applied.
- **126** unsent scheduled join counted as on its way: dropped when its link is gone at its tick.
- **127** lost START_GAME: the beat says whether the start came; the host sends it again.
- **128** duplicate START_GAME: a start already taken is dropped.
