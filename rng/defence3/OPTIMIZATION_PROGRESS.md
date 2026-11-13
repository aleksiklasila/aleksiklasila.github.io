# Simulation optimization: progress log

Working log for `SIMULATION_OPTIMIZATION_REFINEMENT.md` (the plan). Update this
file at the end of every work session: what changed, what was measured, what
is next. Newest entries first within each section.

**Gameplay garbage target (user, 2026-11-04):** aim to eliminate gameplay
garbage and GC. Reserve bounded storage during loading, reuse scratch and
queues, and prefer numeric WASM/SoA state over temporary JavaScript objects.
Zero WASM heap growth alone does not establish zero JavaScript garbage.
Retain allocation profiles and GC pauses, separating simulation, synthetic
input generation and harness/reporting allocations. Do not hide garbage by
forcing collection or moving a pause outside the tick timer.

**TPS spike investigation:** read `AGENTS.md` and
`tests/CHAOS_SPIKES_BENCHMARK.md`. Use the existing per-tick trace/profile
slicer to inspect the previous, slow and next gameplay tick across all
threads, plus a nearby normal tick. Prioritize gameplay p99/max and slow-tick
counts over mean TPS; loading before play is separate. Historical bit equality
is diagnostic; current implementation determinism and intended behavior are
required.

**In-game measurement (user, 2026-11-05):** only the simulation worker's own
heap and timing matter, not the harness's. Measure GC and allocation with
`--worker-post --no-census` (below); stable tick time beats a lower mean with
deviations (110 ms steady is better than 100 ms with 150 ms spikes).

## 2026-11-06: towers: background units table by area, SIMD due table

User: optimize towers with SIMD; the background provides tables the
foreground SIMD-loops over. Smoke tests and benchmarks only (no full suite).

Where towers went (baseline, 1M-start mixed chaos, 1024 map, 11 helpers,
dk=1, 100 steady steps, ~420k -> 300k units, 22k tower rows, 336 due a step
on average, 1364 max): towersTick 4.51 ms mean / p95 6.98 / max 8.98, of it
k_tower_pack 2.66 (every index entry gathered again each step, mostly on the
simulation thread: the helpers were in foreground jobs), k_tower_due 0.33
(serial walk of every row with tile-table reads), scan 0.34, fire 0.17,
hostile tables (k_sat_rows/cols) ~0.3 of the towers' share.

Done:
- Units table on the helpers (tower.js towerPackPost, lane SIM_LANE_TICK):
  posted right after spatialIndexRebuild at the tick's start, settled before
  the laser beams (the first phase writing unit statuses) and before any
  index rebuild/invalidate. Nothing in that window moves, retypes or gives
  statuses to units; a unit dying in it is skipped by the scan (it checks
  live dead for a candidate that would become the best). So towers see the
  statuses as the tick began: one laser phase behind (statuses-lag rule).
  Not ready for this step's index (an invalidation in the window): built by
  the towers' step with the same kernels. Posted or not by towers and index
  only, never by helpers.
- The table is grouped by area (k_tower_acount: atomic per-area counts per
  entry run; k_tower_aoff: offsets, one job, counts back to 0;
  k_tower_pack: each entry run placed at its area's atomic cursor). The scan
  (k_tower_scan) loops each reached area's run four entries a vector: no
  cell lists, stamps, tile starts/counts. Order inside a run depends on
  thread timing, so exact-distance ties are now broken by unit id (slots are peer-local; results
  deterministic; differ from history only on such ties). A first version
  counted by walking every area's cells (~1M tiles): the chain did not
  finish before the beams (lasers 0.45 -> 1.50 ms waiting); counting by
  entry (~420k) fixed most of it.
- Due rows by a row-dense i32 table (tower.js _towerDue, tw.due): the due
  kernel compares four rows with i32x4_le(due, now) and reads the tile table
  only for rows let through; a looked-at row gets ceil(tim)+1, or i32::MAX
  when no tower stands there, its kind does not shoot, or it is being built.
  k_tower_fire writes the next tick of the rows it handled. A value below
  the true one only costs a look, so rows are put to 0 by: Tower.cd setter,
  stationaryBrainChanged (joins, restores, type/level), _stUcSet (built), and
  structCompleteHooks (the worker kernel writes st.uc itself, wai.rs
  p_complete). New table (match, restore, growth): all 0. Peer-local cache.
  Rows looked at: 22k -> ~540 a step (336 due).
- Test: tests/tower-due-table.test.cjs (a tower being built sleeps and fires
  once built; a cooldown set wakes it; the step uses the background table).
  Smoke: tower-kernel-cases, tower-target-batch, tower-simd-determinism (0 vs
  3 helpers), projectile-pool, laser-activation, structure-table pass.

Measured (same command, serial runs, tests/test-runs/tower-simd-20261106,
raw rows in the .json/.jsonl; base.json before, final.json after; the
in-between designs: pack-bg / due-uc (entry-order table), area-pack (count
by cells), area-entry (count by entries, ties by slot)):
- towersTick 4.51 -> 1.14 ms mean, p95 6.98 -> 2.10, max 8.98 -> 3.03.
- k_tower_due 0.33 -> 0.08; scan 0.34 -> 0.16 (p95 0.80 -> 0.40, max 1.97 ->
  1.06); pack on the step 2.66 -> 0.
- laserBeamsTick now includes the settle (area-entry.json: 0.29 mean, p95
  1.02, the helpers' unfinished chain). Towers + lasers per step: mean 4.96
  -> 1.72, p95 7.52 -> 2.65, max 9.36 -> 3.50. The entry-order table
  (due-uc.json: same, without area runs) had mean 1.81, p95 3.30, max 6.01.
- Whole step (noisy single runs): mean 107.4 -> 97.7, p95 143.1 -> 122.2,
  max 180.5 -> 145.4. Population window the same (~421k -> 298k).
- Determinism smoke: multiplayer-chaos-determinism (4 maps, 2598 tick hashes
  each, forced-divergence patches) passes without and with 3 host helpers;
  multiplayer-border-combat passes.

Then (same day): the hostile summed-area tables (mv.hostile / mv.hstruct,
k_sat_rows/cols) are built once a tick, as stages 0-1 of the tick-start chain
(tower.js towerPackPost, every tick, towers or not; the towers' table is
stages 2-4). unit.js _simMoveBuildHostile settles the chain and builds only
if this tick has no build (no chain: at its first use). The towers' broad
phase, the movement kernel and the acquisition's copy read that one build,
so structures removed and unit counts changed later in the tick show from
the next tick (movement used to rebuild after the towers and projectiles).
Every writer of what the chain reads settles it first: _simMoveStructs
(when it writes), _adjustSpatialBlockCount, k_sp_counts, k_spawn_spatial,
k_unit_gone. The JS summed-area fallback loop is gone (the kernels run
without helpers too). Smoke and multiplayer-chaos-determinism (with and
without 3 host helpers) pass. Not benchmarked separately (user: profile).

### Towers as stationary units of the acquisition tier (2026-11-06, later)

User: towers are effectively stationary units; they should work as units do
(the brain), with no expensive foreground step. The tick-start units table
(k_tower_acount / aoff / pack: ~36 ms of helper CPU a step, 3.2-4.0 ms wall
on idle helpers), the broad phase (k_tower_coarse), the unit scan
(k_tower_scan) and the structure scan (k_tower_struct) are gone, with their
JS (_towerPack*). The tick-start chain (tower.js tickStartChainPost /
tickStartChainSettle, renamed) builds only the hostile tables; the laser
beams no longer wait for it.

How towers get targets now (unit.js _acqPost / _acqCommit, every
SIM_ACQUIRE_TICKS = 4 ticks, the tier's area-targets mode):
- At the post: k_tower_acq_snap (a parallel job over the tower rows: tile,
  area, owner, kind, reach from the stat tables or tc.range) and, in the
  units' k_acq_snap, copies of each slot's type, status record and watch
  team; tower.js towerAcqPost copies the status records (burning, wet,
  poisoned, frozen, sandy, watched) up to the pool's high-water mark.
- In the chain, after the area answers: k_tower_acq, as a unit's
  area_answer: the owner's nearest area holding a visible enemy unit
  (acq.saNearest / saDistance at the tower's area) within its reach, then
  the best of a seeded batch of four in that area's enemy buckets: never
  turret-immune; not yet affected and not resisting before affected before
  resisting (as the old scan's classes); nearest; ties by id. Else the
  first structure class answer within reach (acq.saStructure).
- The answers' depth (prepare_area_answers, P[36]) also covers the towers'
  longest reach (towerAcqMaxReach: the stat tables' and custom rows', 8 area
  steps in the chaos scene; 63 first: area answers 6.4 -> 15.4 ms CPU).
- The commit copies the answers into Tower table columns _aqI (unit id, 0
  none) and _aqT (structure tile, -1 none): state (snapshots, hashes, the
  same on every peer); slots are peer-local, so the fire looks the id up.
- k_tower_fire (still O(due)): the preferred target as before, else the
  committed answer checked in O(1): the unit alive, the same id, not the
  tower's owner's, its current area within reach (Arq::within); the
  structure standing, hostile, built where it must be, within reach.
  Nothing found: idle the cooldown by tile phase (as the structure scan
  did). Gone since, or never committed (a new row): wait for the next
  commit (P[13]). cnt[4..8] count outcomes (diagnostic).
- No units listed: the movement's combat scan, which steps the tier, does
  not run; towersTick steps it then (_acqPost runs for towers alone), so
  towers still answer structures (tests/tower-structures-only.test.cjs).
- Behavior changes: targets from a snapshot 2-5 ticks old, as units';
  visibility now filters tower targets (the answers are by cover); the
  nearest enemy area and a batch of four instead of every unit in reach;
  ?acq=exact (no area answers) leaves towers without unit targets.

Tests: tower-due-table (now checks _aqI), tower-structures-only (new),
tower-kernel-cases, tower-target-batch, tower-simd-determinism (0 vs 3
helpers), projectile-pool (bound 250 -> 200 shots: commits every 4 ticks;
247 measured, 238 of them with units as before), laser-activation,
structure-table, wasm-batch-regression (its broad-phase check removed with
the kernel), multiplayer-border-combat, multiplayer-chaos-determinism (with
and without 3 host helpers, forced-divergence patches) pass. A first build
idled every never-committed row a full cooldown (unset columns read as
"nothing"); the shot count caught it.

Profiled (named wasm, settled capture, 60 steps; prof.json before, with
the tower table; prof-acq3.json after):
- towersTick 0.93 -> 0.83 ms mean, p95 2.32 -> 1.49, max 2.53 -> 2.34;
  laserBeamsTick 0.62 -> 0.42 (no wait).
- Helper CPU a step: tower table and scans 36.2 -> tower kernels 0.84;
  k_acq_area_answers 6.4 -> 8.5 (the towers' depth); k_acq_snap 7.7 ->
  11.3 (the copies). Net about -30 ms CPU a step.
- On the tier's post tick (tick % 4 == 2): k_acq_snap 3.8 -> 4.7 ms wall,
  k_tower_acq_snap 0.46 ms.

Left: the units' snapshot k_acq_snap (~3.8 ms foreground on every fourth
tick, the tick % 4 spike) and its new copies (+0.9 ms there): a 2-byte
"tower look" column kept by k_status would replace the three per-slot
copies and the records' copy; k_tower_fire 0.42 ms serial (p95 1.07);
the commit's k_acq_commit (1.5 ms on tick % 4 == 0).

### Occupancy, lanes, index and relayout loop (2026-11-07)

Method: whole-tick timings drift ~7% between sittings, so each change is an interleaved A/B (scratch ab.cjs: A, B, B, A runs of the 1M chaos bench, 80 ticks, warmup 50, the file swapped between runs; outputs tests/test-runs/census-20261106/ab/). Debug counters: `node wasm/build.cjs --features=dbgc` and the bench's new `--dbgc` (with --helpers=0: the kernels' counters a step in each row; the argument block's words 1536.., past _simWasmArgI's 1024). Named profiles without the prof feature: `--keep-names` (the prof feature's inline(never) misattributes).

Counters (427k units, a tick): occupancy walked 926k tiles (222k occupied, 424k index entries), resolved 266k units, 230k moved; 89k blocked movers searched shoulders (93k improvements: kept), 33k swaps tried, 134k yields; 354k steering counts (move_flow 111k: nearly every mover re-steered every tick).

Kept (A/B means, steady / p95 ms):
- The steering stands when the occupancy diverts a unit (mv.rs checked_traffic_q: only the steady window ends; ct / cd were cleared, so every blocked unit re-steered next tick): move_flow 111k -> 70k a tick, steady 93.5 -> 91.5, p95 109.1 -> 104.3.
- The occupancy's tile walks by row masks (mv.rs row_live: a block row's 16 stamps four a compare, the occupied tiles' bits visited in the leader's order; leader_dir too): 926k -> 222k tiles visited.
- The tick-start position from the footprint record (resolve_slot, checked_traffic_q's deposit read ox / oy, not unit.x0 / y0: identical in every case counted) and the epilogue's yield only for entries that may yield (bit 30 of an occ.work entry: yield_tag, a standing unit or a flow walker short of its step): within noise, the same units at the end.
- The flow lane after the hash and index lanes (sim_parallel.js SIM_PAR_BG_ORDER, _SIM_BG_HELP_LANES): 90.5 -> 89.2, the index wait 5.1 -> 4.7.
- The index fill and runs carry their neighbour's key (k.rs k_ix_fill, k_ix_runs: one gather a position, not two); the radix kernels take the digit width (P[6], the prefix's digits P[1]; every caller sets them: a stage's params are reused, so 0 is not a default).
- The relayout's remap tests a moved-slot bitmap first (rl.mbits, a bit a slot set by k_slot_move, zeroed a step; k_slot_remap reads rl.fst / rl.fwd only for set bits): remap 2.37 -> 1.87 ms a relayout step.

- A reused slot made fresh by the slot-zero kernel (sim_unit_state.js _simSlotZeroOne: k_slot_zero for the one slot, not the JS defaults loop): steady 97.6 -> 88.7, p95 143.6 -> 100.0, max 155 -> 102.
- The relayout's period 1024 -> 128 ticks of the units (SIM_RELAYOUT_PERIOD; a step every 4 ticks): the slots' locality pays the step's cost: steady 90.0 -> 87.9, p95 104.0 -> 98.8. 512: +2.4 steady; 64: worse; a step every 2 ticks: steady -1.1 but p95 +1.2, max +3.0 (kept 4).
- The index's fill, runs, id sort and tile owners as one stage (k.rs k_ix_build: a job owns the runs starting in its block): three barriers fewer, index wait -1.06 ms.
- The relayout's slot moves element by element (nfs.rs k_slot_move: memory.copy / memory.fill per column and unit were runtime calls): the move step 12.6 -> 9.0 ms (11-15k units over ~225 columns), steady 89.7 -> 87.7, p95 113.1 -> 100.8, max 114.6 -> 104.7. What is left is the destinations' lines: a unit into a hole of one of ~2100 slabs touches a line a column (a whole slab moved: 14k units in 2 ms).
- The index sorts packed (key, slot) entries (k.rs k_ix_keys writes ix.pkA; k_ixr_hist / k_ixr_scatter: 8-bit digits, the entries carried, no gathers by row; k_ix_build reads them in order). The rows are by id ascending and the sort stable, so a tile's units come out by id: the id gathers and insertion sort are gone (ix.eid only for the builds by changes, P[17]). The synchronous parallel build runs the same stages. Build stage 2.5 -> 1.3 ms, the index phase 3.85 -> 2.99 ms a tick (its wait at the tick's start ~1.4 of that; the rest of lane 6's wait is the separation chain). SPATIAL_INDEX_MERGE's order is no longer used (built whole); its kernels and test are left to remove.
- The id table's hole squeeze branchless, from the first hole (uix.rs k_uix_remove; ~0.5 ms of the index post's main-thread time a tick).
- Fixed (desync): a snapshot restore admitted the queued orders before the units were in the index (utils_snapshot.js), so the admission counted every unit as ground (by unit.sepLayer): the restored peer's flying units of a queued order went to the JavaScript order instead of the movement's pickup (shared-spatial-determinism failed at tick 0, with or without helpers). main.js orderQueueRestore now sets the ordered units' layers (as chunk.js updateUnitSpatial: flying 1, mole 2) before admitting. (Admitting after the spatial insert instead fixed that test but broke multiplayer-chaos-determinism: every forced divergence then needed 3 patches, the queue's hash differing after each.)
- SPATIAL_INDEX_MERGE and its kernels (k_ix_merge, k_ixm_*), the order-array fill / runs / id sort (k_ix_fill, k_ix_runs, k_ix_idsort), simSpatialStableOrderStages and tests/index-merge.test.cjs removed: 199 -> 190 kernels.

Occupancy and per-slot passes (same day, later; named profile with the occupancy's helpers inline(never): checked_traffic_q 51, move_job 31, leader_dir 23, resolve_slot 23, traffic_yield 21, swap 19, preview 19, walker_short 18, cache_chunks 17, epi_slot 16, free_r 15, push_at 15 thread-ms a tick of ~325):
- walker_short's tick-start position from resolve_slot (the footprint's ox / oy, not unit.x0 / y0: two lines a resolved unit) and the last step's pushes as a bit a tile (traffic.rs push_at: config [40] / [41], 128 KB at 1M tiles, swapped and cleared with the records; push_deposit sets it, an atomic or): occupancy 27.4 -> 26.1, steady 88.4 -> 86.6.
- The flow pending scan skips 16 slots without a flow walker by one compare (mv.rs mv_flow_pending); the occupancy job's chunk cache (occ.rs cache_chunks) four tiles a step inside the map, and its tile walk reads the ranges from that cache (MoveGrid::tile_range): occupancy -0.47, steady 85.2 -> 84.9.
- The passes over every slot skip empty slabs (k.rs slab_runs over the allocator's free counts sl.sfree, bound by simUnitStateSlabsBind): the status kernel's tick-start copies, the acquisition snapshot (an empty slab's slots only marked dead / absent / not looked for). In this bench ~26% of the slabs are empty after the first battle (990k slots, 368k units). Status 2.72 -> 2.35 ms, the snapshot 1.16 -> 0.94 ms a tick (4.9 on its tick).
- Tried and reverted: a pass touching each block's units' lines before the occupancy's resolve (independent loads first): occupancy +1.8 ms. Measured, not changed: without the background exact flow looks steady was -2 ms but the first stage +2 (the looks use idle helper time; ~30-60k looks a tick, 6% memo hits, ~28 atlas steps each).

- The relayout's remap and slab scores skip empty slabs too (nfs.rs k_slot_remap per-slot references, slab_scores: an empty slab scores 0 / 0): remap 1.94 -> 1.78 ms a step.
- The relayout twice as often at the same step size: SIM_RELAYOUT_PERIOD 128 -> 64 with a step every 2 ticks (was every 4; odd ticks: data_static.js schedule): two A/Bs, steady 85.0 -> 81.6, p95 95.9 -> 91.0, max 97.5 -> 94.5; the first stage -1.4 ms, the occupancy -1.8 (denser, block-ordered slots pay for the steps' +1.4). Ticks by % 4 now 83 / 83 / 78 / 80 (were 88 / 77 / 84 / 88). 64 every 4 (steps twice as large): steady -1.0 but p95 +0.8, max +2.

- Tried and reverted: a relayout tail slab's units at a quarter of the step's budget (moved whole: ~5x cheaper a unit), the pairs' room cap / 16: steady +0.1, p95 +3.3.
- The acquisition lane (T10) right after the flow lane in SIM_PAR_BG_ORDER (as in the help lanes; was behind T1 / GROW / NAV): its commit's wait (wait:2, 1-7 ms on some commit ticks) 0.18 -> 0.00 ms a tick, steady 82.1 -> 81.3, max 97.2 -> 94.6; no other lane waits more.

- The visibility snapshot skips empty slabs (k.rs k_vis_snap: their keys -1 alone): 0.68 -> 0.58 ms a tick. The dead mark's four-slot skip tests what it marks (out of energy, alive, a unit), not energy alone (a released slot keeps its last energy: every empty group went slot by slot): 0.6 -> 0.3 ms.
- The worker brain's spawner sites (worker_brain.rs k_worker_sites, every tick over every tile): a block row of eight tile codes tested as one word for a spawner's code (0x44) before the four-tile groups: unit events 3.94 -> 3.38 ms, the tick lane's wait 1.31 -> 0.93.

- The worker sites' per-block record zeroed only where it holds anything (most blocks have no site: a line's write a block a tick saved). Not measured alone.
- Tried and reverted: the occupancy's work list carrying each unit's tick-start position (3 words an entry, traffic_yield without unit.x0 / y0; swap partners of other blocks, 3-6 a tick, then saw their post-swap position): two A/Bs, B slower in 3 of 4 runs (steady +3 to +8, a different population path).

Now (current build, 1M chaos, 11 helpers): steady ~80.5-82 ms, p95 ~91-96 (machine drift between sittings ~2 ms). Left: movement ~38.7 (occupancy 24: checked_traffic_q, leader_dir, traffic_yield, the swaps; first stage 8.6), hits 4.1 and spawner queue 3.9 (per-structure JS), index wait ~1.4, relayout ~3.4 a tick mean (slot moves 7-9 ms a step: destination lines over ~225 columns), bursts +8 ms (~400 JS actions).

Where the tick was before the relayout change (85 ms steady, p95 ~96): movement 42.5 (first stage 9.9: ~280k unit lanes a tick off the vector step, 60k re-steers (two a tile crossing: the approximate look's one-tick steer, then the exact one's); occupancy 25.3), hits 4.0, events 4.2, spawner queue 3.8, status 2.4, index 2.8, worker search 2.7. By tick % 4: phase 2 carries the acquisition snapshot (4.9 ms in the movement), phase 3 the relayout (slot moves ~9 ms: the destinations' lines over ~225 columns), phase 0 the visibility coverage, bursts the orders' application (+9 ms).

Tried and reverted: index lane before the hash lane (no change); the parallel merge index build (SPATIAL_INDEX_MERGE: index wait 4.9 -> 7.4, steady +3.9); 11-bit radix digits (index wait +0.6: the wider histograms and their single-job prefix); the delta index build (SPATIAL_INDEX_DELTA: index wait 4.7 -> 12.8, its serial apply); the blocks' leader sums in the first stage (earlier).

Where the tick is now (normal ticks ~89 ms): movement 45 (first stage 10.5, occupancy 27.5: the crowd logic and footprints per mover, compute-bound over 12 threads), the tick start's wait for the index prebuild ~4.7 (a full build every tick, 13 barrier stages; it starts after the tick's spawns), events 4, hits 4.2, spawner queue 3.5, status 3.5, worker search 2.4; the relayout every 4th tick ~6-7 ms (slot moves 4-5, remap 1.9, scores 0.8).
Tests after the loop: occupancy grid / shapes, slot relayout, separation (entry, integration, jitter, kernel replay, rally), traffic pressure, crowd lighting, rally, flow looks, nav cache, batch regression, orders, spawn columns, snapshot, restore, worker walk / approach, tier schedule, event routes, multiplayer-chaos-determinism (0 and 3 host helpers) pass.

### Memory census and first cuts (2026-11-06, night)

Tools (new):
- `tests/chaos-spikes.bench.cjs --census=steps --helpers=0` (hooks: `tests/unit-column-census-hooks.js`): every per-slot array (unit columns and registered arrays a whole number of words a slot) shadowed over the census steps; around each foreground kernel run, background chain run and direct kernel call, the changed elements and 64-byte lines per array; the per-slot arrays each kernel binds; each array's value profile. Report: `node tests/unit-column-census-report.cjs <out>.census.json [profile-run.json] --md=file`. Writes of the value already there are not seen; reads are only the binds.
- `--heap-inventory=steps` (with `SIM_HEAP_SITES=1`): the wasm heap's live bytes by allocation site, every registered array by size, the unit columns, slab occupancy, the navigation slots' use.

1M chaos scene (mega, checkerboard layout, rally mix), steps 40-43 (416k live units in 1.03M slots), tests/test-runs/census-20261106/m1.*:
- Per-slot arrays: 205, 613 B a slot (673 MB at cap). ~2.0M lines written a tick (122 MB): occupancy 812k (occ.rec 167k; x, y, vx, vy ~85k each), the movement kernel's first stage 623k (prevX/Y, x, y, vx, vy, the steering cache mvCT, mvSteady, mvCD, mvCTl, mvCVx/y, mvFloor, mvNav), slot zeroing 193k (130 columns of every released slot), the status kernel 134k (x0/y0: a bulk copy of every slot's position, plus layer, dead and radius copies; attackTimer counted down: 20k), effective levels 48k, flow commit 30k.
- A moving unit's position is written up to five times a tick (x/y wanted, then resolved; prevX/Y; x0/y0; occ.rec), its velocity twice.
- 48 arrays (141 B a slot) hold one value and are never written in these steps (some are features this scene does not use: path windows, lasers on units, the presentation's marks off in the benchmark; the JS-only j__ columns are constructor defaults saved by snapshots); ~210 B a slot narrowable by value range (not tick stamps: mvCT, cbTick, cwTick... hold ticks).
- Slabs (64 slots): at step 100, 3003 of 15481 empty, 12442 partly used (~40% dense): skipping empty slabs would save ~20% of the slot sweeps at most.
- Heap 3.45 GB: worker AI decision arenas 800 MB (wai.ai, wai.a64, out: every unit of the budget deciding at once), unit columns 615 MB, the worker side pool 264 MB (sized for every unit; 16 f64 columns of ticks and amounts), navigation slots 325 MB (ground 2 x 96 MB at 96 B a tile, ~31 MB kept by this map's builds; sized for the worst map), structure tables 126 MB, flow looks 49 MB.

Changes:
- Worker AI pass in batches (worker.js WAI_BATCH 65536 events): decided together, applied in order, then the next (a take round's losers gathered over its batches). The arenas sized to a batch (~45 MB), not the budget's every unit (672 MB). Identical below 65536 events a pass.
- Released slots not zeroed (sim_unit_state.js simUnitStateReleaseFreed): a slot is made fresh when a unit takes it again (simUnitStateAllocate's existing used-bit path, ~130 stores, ~76 spawns a tick here); a released slot already reads as none (dead, not live, no separation key, unarmed: k_unit_gone).
- Measured (1M, 11 helpers, 60 steady steps; prof-pick.json -> census-20261106/mem1.json): steady mean 94.0 -> 85.7 ms, p95 109.6 -> 100.3, max 116.2 -> 102.3, bursts 102.3 -> 92.4; wasm heap 3451 -> 2798 MB. multiplayer-chaos-determinism (3 host helpers) and flow-looks-commit pass.

Steering record (same night): the movement's eight per-mover steering columns (mvCD, mvCT, mvCTl, mvCVx, mvCVy, mvFloor, mvSteady, mvCN; ~350k lines a tick between them) are one column mvSteer, 8 words a slot (sim_unit_state.js SIM_STEER_W / SIM_ST_*; mv.rs SR / SR_*): the Mv fields point at their word and index slot * SR (79 scalar sites rewritten by script), the steady step's four-lane loads gather from the records (sr_ld4: four records, two cache lines, against five lines for five columns); k_order_workers, k_worker_ai, k_unit_cmd and the order pickup index the record; the occupancy's unused bindings of three of them dropped. A fresh slot's floor tile -1 (the constructor's), its destination -1 (the strided default's first word). Measured (mem1 -> mem2): simMoveRun 45.4 -> 43.9 ms, steady 85.7 -> 84.4, p95 100.3 -> 94.9, bursts 92.4 -> 89.4. Tests: the movement, order, rally, occupancy, spawn (unit-spawn-columns found the fresh floor tile), restore and worker smoke tests and multiplayer-chaos-determinism (0 and 3 host helpers) pass.

Occupancy profile (named wasm without the prof feature: `node wasm/build.cjs --keep-names`; the prof feature's inline(never) passes misattribute; census-20261106/prof-named2.json, thread ms a step over the four phases, ~357 in all): move_job 126 (its cell loops, resolve_slot and leader_dir inlined), checked_traffic_q 63, traffic_yield 31, traffic_swap 22, MoveGrid preview 19, epi_slot 18, the footprint's free / mark / motion ~30, traffic sample / push ~12. The traffic (crowd pressure) and footprint logic is ~55%; the per-unit columns a hot record would pack serve epi_slot and part of resolve_slot (~10-15%). Tried: the blocks' leader directions summed by the first stage instead of leader_dir's scan of every tile of a block (it reads one unit per occupied tile; only the signs are used): the first stage +1.6 ms, the phases unchanged: reverted (the prof-feature profile had shown leader_dir at 31 ms).

The occupancy's four phases (~27 ms) visit units in index order and touch ~20 per-unit arrays each (positions, tick-start positions, the footprint record, spatial-index words spTile / sepKey (the same values) / spArea / spMvOld / spMvNew / spMvOwn / spEpoch / spOwner / spType, out, spent, flags...): random lines, ~1 us a unit of thread time. The next layout step is a per-unit hot record for those (positions with them: x and y are bound by 27 kernels, so all of them move to it).

Footprint (2026-11-07): the worker memory's 'N' columns (wmWx/Wy/Wgx/Wgy, wmQr/Qp, wmTrip/Tw, wmReady, wmBlk, wmMan, wmIdle, wmRe, wmMv, wmCarry, wmFailU) f64 -> f32 (sim_unit_state.js _SIM_WK_MEM_TYPES; wai.rs: 59 reads / writes rewritten by script to widen / narrow at the access, values computed as before in f64; ord.rs wm_clear; the state hash's carry (k.rs k_snap_units) and the presentation's meta (nfs.rs k_meta_units) read f32): ticks exact to 2^24, the rest amounts and positions. Six unit fields nothing reads (_statsVer, _thingStatsRefreshStamp, _fpTile, _fpIdx, _fpVer, _pendingDueStamp: their column, alias, default and the constructor's writes) removed. Heap 2803 -> 2706 MB, live 2662 -> 2543 MB at the scene's end. The worker AI's out list (128 MB: 8 out events an event, the budget's every unit) kept: a per-batch flush would run the out events (which may run the pass again) inside the pass. Tick timing this session: mem4 / mem4b 90.7 / 90.8 ms steady against mem2's 84.4 with every phase ~7% slower, the untouched movement kernels too: the machine's state (other load), not these changes; an A/B in one sitting is needed to compare. Worker (research, collectors, builders, take rounds, walk, approach), spawn, snapshot, restore and order tests and multiplayer-chaos-determinism (0 and 3 host helpers) pass.

Next (ranked by the census):
1. Movement's per-unit record: one position (the tick-start one by double buffering or by the movers' list, not a copy of every slot each tick), velocity written once, the steering cache (mvCT, mvSteady, mvCN, mvCD, mvCTl, mvCVx/y, mvFloor) and the per-tick scratch bytes (mvOut, mvSpent, spMvOwn) packed into records the movement and occupancy touch as one or two lines.
2. Timers as deadlines (attackTimer and the like: written when set, not counted down every tick).
3. Footprint: worker side pool f64 -> f32 / i32 (~70 MB), the worker AI out list by batch (128 MB), unused columns removed (j__* and others proven unused in code), narrowing by value range (not ticks), navigation build data (fields, parts) smaller so the worst-case slot shrinks.

### Move orders taken by the movement kernel (2026-11-06, later still)

- No order move pass: the admission (ord.rs k_order_admit) stamps the order's units (ordSq) and lists only workers and held units in the ring; the rest it counts by layer with the first id of each. Each tick _runQueuedOrders takes the ring part (k_order_take, now workers and held only, then k_order_workers) and publishes one row per order (main.js _ordPickPublish: seq, player, command, attack-move tile, issued position, destination by layer from the layer's first unit, wide), the header (rows, the pending way's digest keys, index epoch). The movement kernel's first stage picks the stamped units up at each slot chunk's start (mv.rs ord_pickup: a SIMD scan of ordSq, only when there are rows; per unit the pre-pass and the order's columns, as k_order_move did, then move_span arms it in the same tick). Taken counts and id sums by atomic adds per row; the rare units it cannot take (at their destination's tile, a path window, not indexed, held or a worker since admission) listed by chunk and given the order by _issueGroupMoveOrderList after the movement (orderPickupFinish, main.js after simMoveRun), as before. A stamp of no row (stale) is cleared. k_order_move, SIM_KERNEL_ORDER_MOVE and _orderMoveSlots are gone; _issueGroupMoveOrder (a test's direct order) goes through the queue; orderQueueSnapshot lists an order's units by their stamps (the movement's units are in no list).
- Same-tick check (3,500 units, attack-move): after one tick every one has the command, is armed (mvOn 1) and has moved; no stamp left, queue empty.
- Profiled (prof-ord2.json -> prof-pick.json, bursts, ms): queued orders 6.86 -> 2.07, the order move kernel 3.83 -> 0, the movement kernel 13.05 -> 15.43 (the pickup's own writes: ~2.4 ms for ~160k units); phases ~2.4 ms less a burst. Burst ticks 101.6 -> 102.3, steady p95 111.2 -> 109.6, max 113.7 -> 116.2: within run-to-run noise. Normal ticks: no rows, no scan.
- Tests: hash-queued-commands (the take no longer applies ordinary units: the snapshot's what is left [mine - 3, 2]), order-fast, order-many, order-worker-budget, order-markers, action-ids-codec, shared-spatial-order, scene-orders, solo-snapshot, flow-looks-commit, nav-look-cache-wall, mixed-rally-move, separation-rally, unit-cmd-kernel, wasm-batch-regression, tier-phase-schedule, slot-relayout, tower-kernel-cases, multiplayer-recovery-order, multiplayer-border-combat, multiplayer-chaos-determinism (0 and 3 host helpers) pass.
- Left: the pickup still writes ~25 columns per ordered unit; 11 of them are the order's own values (command, attack-move tile, issued position, route end, profile, path key, rkF, path index, mvCD). Units keeping an order row index instead (a persistent order table, rows living while units use them) would cut that write to one column, but every reader of those columns (ctl, flow, combat, events, workers, presentation) would read through the table: a larger change. Queued orders' remaining ~2 ms: the workers' take and k_order_workers (serial), and the rows' destinations (findNearestWalkable, navApproachTile).

### Order application on the helpers; flow claims short (2026-11-06, later)

- Flow looks' helper claims short (mv.rs FLOW_SPLIT 32: 256 keys at most a claim, unit.js SIM_FLOW_SPLIT). A thread waiting on a foreground kernel takes background chunks (sim_parallel.js _simBgHelp, SIM_LANE_FLOW among its lanes): a whole 8192-key job of atlas steps kept the main thread several ms inside the burst's event kernels. unitEventsRun on bursts 23.4 -> 6.0 ms (prof-fl2.json -> prof-split.json). The flow chain is posted eager (without helpers it runs at the post, not at a later wait after a match restart: multiplayer-recovery-order threw at match start), and a match reset drops its pending looks (utils_networking.js, beside resetOrderQueue).
- The benchmark sends burst orders as the page does (tests/chaos-spikes.bench.cjs): ids of 64+ as uidz (worker.js _queueLocalAction), a JSON round trip, actionsPrepare as the simulation worker on arrival, all outside the timing. Plain id arrays took a path the game does not (JS validation, k_uid_clean serial, two copies, a sort): action processing 14.9 -> 9.7 ms on bursts from that alone (prof-wire.json, the baseline below).
- Ids sorted by the client: the packer thread (info_pack_worker.js selectionIds) encodes each piece ascending: shorter strings, no sort on any peer. k_ids_decode sorts what is not ascending by an LSD radix (ord.rs radix_sort_i32, q.keysOut the scratch), not sort_unstable.
- Admission (k_order_admit) and take (k_order_take) by jobs of ORDER_KERNEL_PER_JOB (now 4096; 16384 left most helpers idle on an 80k order): each job from its first place (job * per), counts and sums per job in q.jc (8 words a job). Admission: each job binary-searches its first id in um.ids; a repeated id (sorted: next to it) passed over; an earlier order's live count and sum by atomic adds (the same whatever the timing). Take: always whole (the partial take, need, was used by no caller; hash-queued-commands takes the first order whole now); each job's kernel units radix-sorted by slot; per layer the count and the first in ring (id) order (the destination's unit: the same on every peer, the slots are peer-local); the others compacted in ring order for k_order_workers.
- The pre-pass (k_order_pre, its kernel 147, ord.pst) folded into k_order_move: the group-path wait and the pending way let go per unit, then the order. The move kernel's job k walks take job k's slot-sorted list: its columns in memory order. The JavaScript loop _orderMoveSlots kept as a no-kernel branch is gone.
- Profiled (1M-start chaos, burst every 10 steps, 60 steady steps; prof-wire.json -> prof-ord2.json, ms): queued orders on bursts 9.77 -> 6.86 (move 5.23 -> 3.83, pre 1.40 -> 0, take 1.23 -> 1.14, admission 1.85 -> 0.99); burst ticks 104.5 -> 101.6, normal 93.9 -> 93.5; steady p95 121.4 -> 111.2, p99 / max 136.3 -> 113.7 (318k units at the end).
- Units left to the JavaScript by the move kernel: 2 of 28,002 over a 14k-unit mixed scene's bursts (at their destination's tile).
- Tests: action-ids-codec, order-fast, order-many, order-worker-budget, order-markers, hash-queued-commands, shared-spatial-order, scene-orders, flow-looks-commit, multiplayer-recovery-order, multiplayer-border-combat, multiplayer-chaos-determinism (0 and 3 host helpers) pass.
- Left: the move kernel is memory traffic (~40 unit columns written per ordered unit, ~1.9 ms per 80k-unit order). The next step is to apply the order inside the movement kernel, which reads those columns every tick anyway: admission stamps the units (ordSq) and the order's table row (command, target, destination by profile, wide); the movement kernel takes a new stamp per unit. That removes the take and the move pass (~5 ms on bursts) and makes the foreground O(1) per unit. k_order_workers stays serial (~1 ms). Action processing's other ~5 ms on bursts is the index settle and worker AI that would run in the tick anyway, plus research and place actions.

### Flow looks off the turns: O(1) fallback, exact on the helpers (2026-11-06)

User: the foreground kernels must never wait or compute a cache miss: an O(1) approximate answer, the miss marked pending, the helpers fill it in and it is committed at a deterministic tick (1 or more sharpenings); the foreground a set of parallel SIMD loops, anything more complicated a background task. (A first prewarm, the helpers filling the shared table before the movement, made the movement wait for it and missed the burst: units ordered in a tick are armed onto their route inside the move kernel. Removed.)

- Turn (mv.rs flow_look): the record (exact, or a committed no-way code: LOOK_CODE_BASE + code), the direct look (O(1), exact), else flow_look_approx: along its last answer when standing on that answer's next tile, else the open neighbour toward the destination on its longer axis, then the other (none: stands this turn). Written as an approximate record (kind | LOOK_APPROX), steered for one tick (cn 1). The turns no longer read or write the shared look table (a hit or miss there would depend on the helpers' timing) and never make a look (flow_look_calc gone; flow_look_vals the answer without a record).
- After the movement (unit.js flowLooksPost, main.js after simMoveRun): mv_flow_pending (foreground, parallel) lists each flow walker whose record is not the exact answer where it stands: [unit id, tile, destination, field id, key word, build, walls' version in reach, field generation]; mv_flow_exact on a new lane SIM_LANE_FLOW (13; control words relaid: ERR 120, CAP 121, RUN 122.., FIRST 136, BG_ERR 137..; it ranks second after the tick lane) makes the answers (mv.lookc now the helpers' memo; the field and build checked before and after, else FLOW_STALE).
- Commit at the next movement's start (simMoveRun: flowLooksCommit, the one wait): mv_flow_commit puts each answer into its unit's record (by id through the id index: slots move in between), when the unit, its route, the build, its field's generation and the walls' version in reach are as listed. Nothing else waits for the helpers but a look table reset (simMoveLookCacheClear). A resync (simMoveDisarmAll, every peer) drops the listed ones.
- Tests: flow-looks-commit (new: the chaos scene with orders hashes the same with 0 and 3 helpers every step; records mostly exact), nav-look-cache-wall (rewritten for this: no look committed after a remote wall edit leads into it; emptying the memo every tick changes no record or position), nav (atlas, background, flow-width, reach), order (fast, many, markers), tower, projectile-pool, tier-phase-schedule, slot-relayout, multiplayer-border-combat, multiplayer-chaos-determinism (0 and 3 host helpers, forced-divergence patches) pass.
- Profiled (1M-start chaos, named wasm; prof-acq3.json before, prof-fl2.json after; normal / burst ms): move kernel 19.9 / 31.4 -> 12.2 / 13.3; simMoveRun 59.3 / 68.2 -> 49.9 / 46.8; new: pending scan 2.4, commit 0.8-1.1, the commit's wait 0.01. Ticks 104.4 / 116.4 -> 95.8 / 119.2, p95 144 -> 137. (Committing at the tick's end first: the burst waited ~11 ms there for the answers, 121.2 ms; moved to the next movement.)
- Left: the burst is now the orders' application (~23 ms on the main thread: action processing 12.6 (admission, id decoding and cleaning), queued orders 9.6 (take, prep, the order kernel 4.7, k_order_workers ~5 serial)); the pending scan (2.4 ms, every slot) could be fused into the occupancy epilogue, where each unit's final tile is known; looks for units armed onto a new route keep the approximation for one tick.

### Tower orders, tick-phase spread (2026-11-06, later)

- towerTarget with a structure target goes through k_tower_target like a
  unit target: every selected tower of the player takes it. The old rule
  (a structure order replaced only a live lock, other towers were cleared)
  and its per-tower JavaScript (resolveTowerPreferredTarget,
  stationaryBrainChanged: ~6 ms on the chaos bursts) are gone;
  tower-kernel-cases checks the new rule.
- The slot relayout (peer-local) counted its own calls and ran on base
  ticks % 4 = 0 and 2, on top of the coverage and the acquisition commit
  (0) and the acquisition post (2). Now every 4 ticks on % 4 = 3
  (SIM_RELAYOUT_EVERY 4, SIM_RELAYOUT_PHASE 3: its share per step doubled)
  and skipped on a tick that applied queued orders (main.js
  orderAppliedTick): bursts never carry it. (On % 4 = 1 and 3 first: the
  bench's bursts land on odd ticks and step 80 stacked burst + relayout +
  the search commit + the dead's slots: 162 ms.)
- Unprofiled, same scene (steady.json before, spread2.json after; single
  runs, noisy): non-burst means by tick % 4 94.2 / 84.0 / 100.2 / 81.1 ->
  86.1 / 85.2 / 95.2 / 90.5; steady mean 93.1 -> 92.2, p95 117.6 -> 116.5,
  max 127.3 -> 132.9 (a burst, step 90, on % 4 = 3); bursts 114.9 -> 116.9.
- Left by phase: 2 (acquisition post: k_acq_snap ~4.5 + setup, occupancy
  slower by the chain) the high point; 1 the search commit (~5) and the
  dead's slots zeroed (k_slot_zero ~4.2, deaths after the acquisition
  commit's tick); bursts +25-30 (orders' application ~10 on the main
  thread, the move kernel's flow-look misses ~10: Atl::exit's per-job exit
  cache starts empty for every chunk, each ordered unit's tile walks 32
  atlas steps toward the new destination).

### Profile of the longest ticks (2026-11-06, prof.json)

Named wasm (tests/test-runs/named-wasm32.js), settled capture from step 59,
60 steps, all 12 threads, 5 ms sampling; steady p50 98 / p95 128 / max 133
ms (~330k units). The 8 longest (70, 80, 65, 100, 90, 69, 61, 63: five are
the 10-step action bursts) aggregated with scratch agg.cjs over
chaos-spike-profile (reference: nearest step of the same burst status).

Phases, mean over those steps (ms): gameTick 115.7; simMoveRun 64.6 (the
move kernel, kernel:8, 25.3; the four occupancy passes, kernel:89:0-3,
8.0-8.3 each, 32.6 together); processActions 7.9 (19.8 on step 70: the
burst); runQueuedOrders 6.1 (k_order_move, kernel:101, 3.0); unitEventsRun
6.0; spatialIndexRebuild 4.1; processGlobalSpawnerQueue 3.8;
unitHitsResolve 3.7; statusPrepassRun 3.6; workerSearchTierStep 2.7;
recalculateUnitEffectiveLevel 2.6; towersTick 1.2.

Inside the movement (step 70 against 80, sampled CPU over all threads):
- Occupancy passes: mv::move_job's own code 109 ms, checked_traffic_q 44,
  traffic::sample 23 (only on the slow step), leader_dir 21,
  traffic_yield 21 (10.6 on the reference), traffic::push_deposit 16,
  occ::free_r 15. Helpers also ran background lanes inside these passes
  (k_ws_nearfield 16, k_unit_events 7, k_ws_scan 7).
- Move kernel: flow_look_calc 71, atlas_step_h 49, Atl::exit 45 (17 on the
  reference: grows on the slow step), seg_open 40 (22), mv::park 24 (0 on
  the reference), move_job 24, move_flow 16, move_pre 16.
- Main thread over the longest steps: move_job 9.5, simParallelRun 3.8,
  checked_traffic_q 3.5, traffic_yield 3.4, seg_open 3.1, k_order_move 2.6,
  GC 1.3.

Ideas from it: the four occupancy passes are each ~8 ms with the same
functions (traffic queue checks, leader direction, yields): the pass count
or what each pass recomputes is the biggest lever (~32 ms); in the move
kernel, flow lookups and atlas exits/steps (~165 ms CPU) are next, and
Atl::exit / park / seg_open are what grow on the slow step; the bursts'
processActions + k_order_move (~25 ms on step 70) for the burst spikes.

## 2026-11-05: command bursts: no budgets, numbers, preparation (branch claude/gallant-shaw-b7cbef)

User rule: the main thread only applies (O(1) / O(things changed) per command); the work is prepared off the tick and done by kernels; no arbitrary per-tick limits.

Done (smoke-tested, not benchmarked): background nav builds reuse unchanged clusters' local fields (nav_cluster_same); pending path target and fallback flag as numeric heap columns (ptSt..ptSub), cleared in k_order_pre; structure row expiry staggered over 16 ticks by tile; research lab counts per owner kept by the structure tile table and the destroy kernel (capacity = structLabCount[p] * 20, one read); towerTarget in a kernel (k_tower_target) by the tile table; research queue as numbers per player (p._rq: stat ids, per-stat depth and progress; task objects are views, kept by (stat, level)); action budget / backlog / split / jump removed (every action whole at its tick); move orders applied whole at admission (no ORDER_NOW / 4-tick slicing).

Measured per-command (120 ticks of the 1M scene, before the last two): queueResearch 125 -> 12 us, moveResearch 4 ms -> gone, towerTarget 4.8 -> 1.4 ms per 2000 towers. Back to back under load before/after the nav reuse + expiry stagger: max 218 -> 159 ms, p99 188 -> 142, p95 147 -> 126, mean 108 -> 101.

Next: commands prepared when their tick arrives (sim_worker stream: decode ids, clamp, tiles packed; state checks stay at apply); the research queue in the wasm heap; setRallyMany / setAutoUpgrade / setAutoStack / place / attack / hold / stop as kernels over prepared tiles and slots; ACTION_MAX_UNIT_IDS (20000 per action) and the pathfinding.js group-route budgets removed. Open: multiplayer-recovery-order diverges at tick 260 (also before these changes).

Since: commands prepared when their tick reaches the worker (main.js actionPrepare, sim_worker.js tick stream and sealed bundles): ids decoded, tower / rally / toggle tiles packed; rally applies all tiles through k_rally_tiles (no 5000 cap; presentation rally cells by tile, simPresentRallyTiles); structure progress ops of a tick's commands run in one waiRun (structProgressBatchBegin / Flush); setToggleMany (one command per selection for auto-upgrade / auto-stack / build / queue / research / salvage, k_struct_flags in ord.rs; info panel and HUD group buttons send it); q/e send one resizeUnitGroup (bySub: the sim splits by subgroup); ACTION_MAX_UNIT_IDS no longer limits (1 << 30; the order queue scratch is the unit budget), so selections are not chunked into 20k-id commands. Tests changed for the removed caps: tower-kernel-cases (no 5000-tower cap), research-queue (views healed by a real change), structure-row-* (stagger), research-rebase-partial removed; new: research-lab-count, tower-target-batch, toggle-many.

Then: hold / stop / attack / attackBuilding / killUnit by k_unit_cmd (uix.rs; ids prepared as Int32, resolved and deduped in the kernel, digest terms of hold and the pending way; equal to the setters: tests/unit-cmd-kernel), stopped workers by k_order_workers mode 2 (the task let go as _clearWorkerTarget + clearWorkerTaskMemoryForFreeRetarget, IDLE); spawnCounts (a group's spawn queue changes in one command: hud queueGroupSpawns / dequeueGroupSpawns, count_bars); orderMany (multi-point move / attack-move / worker assign in one command: main.js applyUnitCommandTargets, the assign worker, applyWorkerAssignTargets; tests/order-many). Unit paths in a heap store (sim_unit_state.js SIM_PATH: arena blocks by pow2 class with free lists and refs, a shared path array stored once; the pthH move column; Unit.path a view of its block, kept per block gen; k_unit_cmd and k_order_workers mode 2 let paths go in wasm, lib.rs path_release; no _path JS column). Spawn queue commands by k_spawn_counts (spr.rs: group and single-building queue / dequeue over the production pass's class table, fronts' costs from spr.tab with missing keys filled first, emptied queues' timer and ready order cleared; equal to the queue functions: tests/spawn-counts-kernel; production itself was already k_spawn_prod / select / shift). _dropQueuedOrderUnits by k_order_drop (ord.rs); the research queue's numbers in the wasm heap (data_dynamic.js SimResearchQueue: ids, depth, prog, hdr) with its changes by k_rq_op. Left: q/e (resizeUnitSubgroup) as a kernel; spawn queue fronts and spawnerProductionChanged as kernels; the preparation (id decode, tile packing) in wasm on helpers; research queue in the heap; _dropQueuedOrderUnits as a kernel.

Unit stats as heap tables (done): things_utils.js unitStatTables: a static Float64 table [type][level][stat][research level] from PRECOMPUTED_STATS_MAP.unit (no owner), per-player research and boost index tables (RL, BL), and wasm/src/k.rs k_stat_fill writing the kernels' rows per (player, type, level) (eff.* columns, eff.hot, and eff.bVer / bRad / bMaxE / bRow as views of them) at the build and for a (player, type) at each research or boost change (effSharedTablesChanged). unit.statRow / bsRow are those indices (no rows made on demand, no row objects, no base noting); Unit.preComputed* are views of the player's shared tables; snapshots no longer carry per-unit tables (derived). k_eff_units takes new base levels and units without kernel fields itself (table base entry), so the JS full path is left only for units without a slot / area. The metadata kernel reads the unit's maxE. tests: eff-behind-kernel (kernel = full path over 240 ticks of researches), shared-stat-rows, chaos replay. q / e by k_unit_resize (k.rs): subgroups by radix sort, d2 kills the second half, x2 spawn templates within stacks / double / population room (JS spawns them beside their templates), then stacks spread evenly, levels from stacks, maxEnergy from the table, energy water-filled (sum never grows); tests/unit-resize-kernel.

Next (profiled, 1M scene, main-thread self time per tick): the presentation's structure metadata cycle is the top JS: _simWriteStructure 27 ms, simPresentationMetadata 18, table accessors 10, _sDerivedValue 6, _sThingStatEntry 5, getEntityEffectiveVisibilityRangeArea 3 (~70 ms a tick of the sim thread while it runs; a cycle over ~65k structures takes seconds, so structure bars / timers / levels refresh slowly). Plan: k_meta_structs over the structure class tables: slots by a row -> slot column (_psl) and a slot -> (class, row) map kept by SimSlots on assignment / free (O(changes)); every slotted row written from its columns (energy, timers, stacks, levels, queue, flags, statuses, rally, type codes by the shared-id type columns), derived max energy / damage / vision from the static building tables (stt.*) with the owner's research and boost levels (adj.rlv / adj.bl), spawn cooldown from spr.tab, research progress per owner; rows gone listed for the JS to free their slots; the grid cells copy as a kernel too. Left on JS after it: dropped items (not tabled), laser links (connectedLasers arrays), tower attack-target positions unless in columns, level labels (small games only).

Structure metadata kernel (done, 2026-11-05): wasm/src/nfs.rs k_meta_structs writes every slotted structure's presentation row from its class table (slot -> class << 24 | row: _simStructSlots.psrc, serials beside it in pser, both heap), derived max energy (kinds <= 3) / floor-item damage / vision from the static building tables with the owner's research and boost levels, spawn cooldown from spr.tab (keys of other stats versions listed and filled by _spTabFill, then written), lab research per owner; rows gone listed and their slots freed. The JS cycle branch (SIM_META_STRUCT_KERNEL) is gone. A slot-list mode writes the tick's changed tiles too (_simPresentStructureChanges: JS keeps only the slot bookkeeping; both tables while a bigger one fills). The tile -> slot map lives in the heap (no copies). The grid cells: the presentation reader gets views of map.js cellType / cellOwner (shared) and diffs them itself; the sim thread copies nothing (simFrameEncodeState's start diff reads the columns). Left JS: laser links, level labels in small games, the start frame (simFrameEncodeStructures). tests/meta-structs-kernel (cycle and changed rows = _simWriteStructure, 3686 structures through chaos orders).

Dropped items removed (2026-11-05): addDroppedItem had no caller, so none were ever made; their list, grid (a JS array of nulls per map row at every start), area buckets, decay loop, snapshot list 'd', presentation kind 6, worker drop targets and drawing are gone.

Also (2026-11-05): a guest restored from a snapshot had its research queue as the plain copy under the views (R.rehome is not a function on queueResearch / dequeueResearch: multiplayer-chaos-determinism failed); _rqAttach makes it the heap queue again (six maps pass, 2598 hashes each). The unit events JS branch (UNIT_EVENTS_SPLIT false) removed: the split kernel always runs. A page whose simulation is in its worker skips k_stat_fill (no kernels, no unit rows there): solo-snapshot crashed at start.

Conversions (2026-11-06), the Still-JS list:
- Structure presentation wholly by k_meta_structs: the start frame (simFrameEncodeStructures: a heap table copied into the frame buffer), the laser links (a second pass over the partners in lz.lslot / lz.pn / lz.part by the tile -> slot map), the level labels (the label column, now i32, packs level / effective / potential / researched max; the page formats the text, sim_frame_world.js simLabelText; no more units.length < 5000 limit), mine amounts from _ST.val. _simWriteStructure, _simMetaLasers, _simWriteStructureLabel gone from src (the writer is tests/_meta_structs_reference.js, the reference of tests/meta-structs-kernel).
- Worker drop-target leftovers gone (k_ws_scan drop penalty, wai tt_drop, SIM_WT_DROP).
- pathfinding.js 2634 -> ~700 lines: the JS A*, group routes and their flow slots, path regions (reg.rs and k_reg_tiles; nothing read them), MinHeap, step costs, the correctness harness: none was called in play (units use flownav.js). k_tile_occupied kept (tch.rs). Tests of them removed (pathfinding-routing, group-path-limit, path-regions-*).
- findNearestWalkable by tch.rs k_nearest_walk (ring search over the unit's walls: ground mv.wall, builders' class walls, flyers none; collectors on active mines, owners on built cloud towers); mv.wall rebuilt by k_walls_from_types (SIMD) instead of a JS loop over cell views. tests/nearest-walkable-kernel (7000 queries = the old ring search).
- Effective levels wholly by kernels: k_eff_units hands nothing back (no flag 2; a unit not in an area counts itself), new levels' rows / maxEnergy / energy / movement columns by k.rs k_unit_stats_apply (from the hot row, a per-type style/laser table U.tys, eff.rWch watch ticks; an area box not made yet disarms), small games use the kernel too (EFF_STATS_KERNEL_MIN_UNITS gone), a restore's stale owners by effStatsAllUnits. _effStatsFullUnit and its helpers gone.
- Left JS: units are still Unit objects (made per spawn, S.owners): the spawn batch's per-spawn set-up and finish, move orders' workers / held units, the pending-target rechecks (_tryUpgradeAstarFallbackPath) are per-unit JS over those objects; removing the objects is the next big step.

Unit objects, measured first (2026-11-06, chaos 250k units, 3 helpers, tests/test-runs/unit-objects-20261106): the objects are near-pure views (own fields: _us, _h, the dead-record fields, _det); the steady tick's game JS is small (accessor get ~3 ms, getTileEntityRef ~1.4 ms of ~140 ms, the rest wasm). The spike was tick 0: 3491 ms, its JS the structures' and visibility's per-object loops. Fixed:
- The visibility cover switched on at match start where the simulation runs (main.js startGame: build/stack checks in the first tick's commands took the whole JavaScript grid, computeVisibilityGridForPlayer and its sources' signature, ~250 ms); a player's rows painted by tch.rs k_vis_paint (was area by area over cell objects, 135 ms).
- The movement kernel's structure tables (mv.struct, mv.scls, mv.stblk) by tch.rs k_move_structs from the tile table, whole and for the changed tiles (a heap list now); tests/move-structs-kernel.
- The work-site grid's reservation bits by k_wsw_resv (was a JS walk of tiles x load types through workerReservedAt); the visibility kernels' area cells by k_area_cells (a counting sort over cellArea; vis.areaGrid is cellArea itself).
- Tick 0: 3491 -> 1328 ms (now wasm: first acquisition, the opening orders on 250k units).
Left JS: per-event glue (a destroyed building's grid item, walls, effects and sound; the unit events' JavaScript part, waiOutEvents); the harness's own command generation is most of the profile's anonymous JS.

Slow ordinary ticks (2026-11-06, same run): every tick over 180 ms was navTick waiting ~118 ms for its build (wait:1): the stage gap was 2 steps at dk 1 whatever the map, shorter than a 1024x1024 build on the helpers. flownav.js _navStageGap now sizes it by the map (NAV_BUILD_TILES_A_TICK = 131072 tiles a tick, as steps of the step size; map and step size are every peer's, the same schedule). 250k chaos: mean 123.6 -> 106.2 ms, p95 213 -> 130 ms, p99 257 -> 248, max (tick 0) 1277.
Now: movement ~50 ms a tick (SIM_KERNEL_MOVE ~20, the MOVE_OCCUPANCY stages ~30), wasm ~78 ms of ~106; the game JS ~15 ms spread thin (spawning ~4.5 ms: the per-spawn object set-up in _simUnitSlotStart, _spawnEnd, _spawnStats; structure-hit visuals ~1 ms; the rest under 1 ms each).

Spawn glue (2026-11-06): a spawn batch's new units go into the spatial index together at the batch's end (tch.rs k_spawn_spatial: tile, chunk key, area, owner, type by the upkeep-type names, separation layer, epoch, disarm, the chunk / type-block / 8x8-block counts; queued as before during the unit pass) instead of updateUnitSpatial a unit; a healer's spawner rally pins its queue target and leaves the search to the worker kernel at its due check (no _healerFindTarget JS search). 250k chaos, ~197 births a tick: 36.1 -> 33.8 us a birth (~6.7 ms a tick). tests/unit-spawn-columns equal.
Left per spawn (~20 us JS): the slab allocation and the object's set-up (simUnitStateAllocate, _simUnitSlotStart's non-enumerable fields), the first unit of a template key's full stats (_spawnStats), _spawnEnd's rally paths / id index / work marks. The way out is a slot-based spawn kernel (slots, ids, columns, occupancy, index, rally flows in wasm; the objects made on access).
Failing before this work too (clean HEAD): worker-take-rounds (one take round), starting-spawn-limits (pow2 population: 8192 vs 12000).

Remaining failures (2026-11-06):
- index-delta: a relayout keeps the by-changes unit index (tch.rs k_ixd_relayout, sim_unit_state.js _simRelayoutIndex: the index entries' slots remapped, the per-slot listing moved by the pairs), so the next build stays by changes. The bug was rl.fwd: it holds only where rl.fst is the step's stamp (never cleared, zero when new), so unmoved slots were remapped to slot 0 and their removals were lost (listed 2249 want 2091). It now takes rl.fst and the stamp. Passes on all three maps (201 of 260 builds by changes); slot-relayout and chaos-scenario-determinism pass.
- A dead unit's slot returns to the free list at the next index build (one tick), on purpose. The unit itself is removed in its tick at O(1) a death (retire pass, k_unit_gone). Freeing the slot mid-tick would let a spawn later in the tick reuse a slot the tick's index still names (slot numbers are peer-local after relayouts). Avoiding that needs a per-slot entry position kept by every index build (O(units) scattered writes a build) or an id check in every index reader. A guard added for "relayout into a dead unit's slot" was removed: relayout runs after the retire pass, before any release, so the case does not occur.
- worker-fallback-upgrade: the test's source slice now starts at _pendingPathDest (the scratch the function uses). action-clean-native: ACTION_MAX_UNIT_IDS is 1 << 30 (no cap), so the test sizes itself (24,300 units, 30,000 invalid ids). The constant itself (about 15 sites) is still to remove.
- multiplayer-chaos-determinism (arena): guest3 needs repairs every 40 ticks for region 8193 (tiles 4-7, 32-35) after its forced divergence at tick 541. Measured: the lockstep hash parts agree; every hashed unit column (k_snap_units inputs, per-record status and worker columns) agrees; hObj matches the fields on every peer. Differing state is peer-local or unread (handles, slots, rows, esVer), plus the tower cooldown deadline st.tim at 7,35 (host 380, long past; guest3 0). The whole-state hash (all slices) agreed for the region and the unit order matched, so only a slice-only part could differ: the structure core sweep (_snapStaticCoreSweep) reads st.tim. The healer spawner at 7,35 had tim 380 on the host with its spawnTimer 0: spr.rs k_spawn_counts zeroed an emptied queue's timer column but not st.tim. A restored peer rebuilds tim from the field (0), so the region never agreed again and every repair "failed". k_spawn_counts now takes st.tim [9] and zeroes it too (barrack.js spawnCountsKernel passes it). The core sweep also takes a tower's cooldown left (max(0, tim - gameTime), the snapshot's cd), not its deadline: a long-expired deadline is the last shot's tick on the host and the restore's tick on a restored peer.
- Full run after these: 272/272 test files pass (tests/run-all.cjs --jobs=4 --timeout=1500).

Slow ticks now (2026-11-06, chaos 250k units, 3 helpers, 160 ticks, warm-up 40; tests/test-runs/slow-ticks-20261106, analysis slow-ticks.cjs): steady mean 104.2 ms (was 114.1), p50 103.3, p95 129.8 (205.5), p99 148.1 (225.9), max 154.6 (239.5). 56 ticks above the mean average 116.1 ms against 93.8 for the rest; the ~20 ms extra is no single phase. It is the periodic lane steps landing on the same ticks: syncVisibilityCoverage every 4 ticks 8-11 ms (VIS_SEED_STRUCTS ~6 of it), workerSearchTierStep 7-12 ms every 2-4 ticks, adjacencyLaneStep every 8 ticks 6-8 ms, SLOT_ZERO (released slots) 3-6 ms on some ticks, the bench's command bursts every 10 ticks (processActions 8-16 ms); 48 of 120 ticks carry two or more of them, 32 of those above the mean. Movement itself varies +6.7 ms (MOVE +2.2, the occupancy stages +3.7). The worst ticks (125-155 ms) are those where the visibility sync, a slower index build (9-15 ms, typical 4-5) and the worker search tier coincide. Next: spread these steps evenly over their periods (a share a tick, or phases offset so no two meet), the visibility coverage sync first.
Tier steps on even ticks (2026-11-06, same scene and settings; tests/test-runs/tier-phases-20261106, phasevar.cjs = every phase by tick % 4, bymod.cjs = the periodic steps by tick % M). Before, base tick % 4 === 1 carried the coverage sync (~8 ms) and the worker search commit (~5.5) and % 4 === 3 the search post (~11) and, every 8, adjacency (~7); % 4 === 0 and 2 had none. Now each % 4 tick has one share: 0 the coverage commit+post (VIS_COVER_UNITS_PHASE 1 -> 0), 1 the search commit, 2 adjacency with its commit (% 8 === 2) and its post (% 8 === 6) half a period apart (each ~half of the old step, and a batch is applied 4 ticks after its post instead of 8), 3 the search post. The schedule is written down in data_static.js ("The tier steps' ticks"), checked by tests/tier-phase-schedule.test.cjs (the steps' real calls, at most one a tick). main.js's synchronous adjacency recompute at the batch tick now runs only without the lane (it would have run at every commit tick: nothing posted there). Mean tick by tick % 4: 92.6 / 97.1 / 95.2 / 93.3 ms (was 96.9 / 111.4 / 100.4 / 108.0: spread 4.5 ms, was 14.5). Steady mean 94.5, p50 92.7, p95 114.0, p99 124.2, max 139.5 (104.2 / 103.3 / 129.8 / 148.1 / 154.6); the population path is the same (113,371 units at step 150, was 113,364). Most of the mean's -9.6 ms is spread over phases the change does not touch (simMoveRun -3.6, every kernel ~8% lower): machine state, not the schedule; relative to the mean, p95 went 1.25 -> 1.21, p99 1.42 -> 1.31. Left uneven: % 4 === 1 is ~4 ms heavier (the search commit 4.8, plus the deaths after the acquisition commit at 0: slot clearing 2.7, the index +3, towers +3); % 4 === 2 has the spawner production's cluster (SPAWN_PROD 5.1 vs 1.4, processGlobalSpawnerQueue +4: the scene's spawners' timers are in step, not a schedule); % 4 === 3 is the search post alone at 11.4 ms, the largest single share. Smoother next: split the search post (its select and group build, kernel:129 2.7 ms, from the scan post) over two ticks, and the burst ticks (the bench's commands, % 10) remain 11 of the 52 slow ticks.

Tier shares cut (2026-11-06, same scene; sub2-sub4.json with SUBPHASES and the bench's new --rust-direct (serial Rust calls as rust:<name>), now2.json clean). The search post was 10.35 ms: k_ws_candidates 3.2 (a gather of up to 8 structure tables' rows, a radix sort, a dedupe, serial), the group kernel 3.1, k_ws_buckets 1.6, the return spawners 1.9 (k_spawner_index 0.9, a JS loop over the spawner index). Now: k_ws_candidates is one SIMD pass over the tile codes (st.code: spawners 0x44, floor items 0x55, mines 0x66/0x77, a structure's code on its anchor tile only, so the same tiles in tile order with no gather or sort): 3.2 -> 0.77 ms for both lists; the return spawners' JS loop is a kernel (ord.rs k_ws_spawner_snap); the post 7.4 ms. The coverage's buildings (k_vis_seed_structs, 5.3 ms synchronous at the post) go into a per-player-and-area steps table (vis.sst, two halves) a quarter of the map a tick (phases 1, 2, 3 and 0; ~0.8-1.4 ms each, atomic max: any order), and the chain's new first stage (vis.rs k_vis_seed_sst, i32x4 sign test, a job a player, plain writes) puts the finished half into the run's seeds on the lane: the coverage tick 7.5 -> 2.95 ms (its snapshot kernel 2.1 of it). A building's sight still comes and goes within two periods (visibility-buildings). Clean run: steady mean 95.8, p50 95.3, p95 118.6, p99 126.5, max 133.3 (the first round's run: 94.5 / 92.7 / 114.0 / 124.2 / 139.5; simMoveRun +0.8 ms in this run, a phase not touched: the machine), by tick % 4 92.2 / 97.8 / 97.5 / 95.7. The search tier step's mean 4.50 -> 3.98 ms a tick, the coverage's 1.87 -> 1.51. Left: kills are locked to tick % 4 === 0 (units lost in the tick by % 4: 1634 / 242 / 263 / 70): the combat brain's instructions are committed for every unit at the acquisition commit (k_combat_commit, phase 0), and units waiting for their next word after a kill (mv.rs CM_WAIT) all fire then; the next tick (% 4 === 1) carries the dead slots' clearing (~3 ms), the index's extra (+3.4) and the towers' retargeting (3,401 tower queries against ~300-700). Staggering the brain's take by unit id (as the acquisition take already is) would spread that, but changes when units resume fighting.

First shots staggered (2026-11-06, stagger.json): k_combat_commit gives a unit that starts firing with the new word (it waited, CM_WAIT, or had no fire bit) an attack timer of id % 4 base ticks (no new columns; units already firing keep their rhythm). Units lost by tick % 4: 708 / 622 / 529 / 410 (was 1634 / 242 / 263 / 70); slot clearing (kernel:128) 1.06 / 1.60 / 1.37 / 1.22 ms (0.56 / 2.61 / 0.73 / 0.80), the index rebuild's extra at % 4 === 1 5.1 (6.1). But the ticks are not flatter: 92.5 / 98.3 / 104.1 / 100.1 ms, steady mean 98.7, p95 118.2, p99 135.3, max 149.9 (now2: 95.8 / 118.6 / 126.5 / 133.3; one run each; ~1.4% more units alive at step 150, 114,986 vs 113,394: the slower first shots). The tower retargeting at % 4 === 1 did not move (tower queries 2397 / 976 / 978 / 1659 against 2349 / 968 / 967 / 1634): it is the towers' own timing, not the kills. The clusters that make the tick totals now: towers at % 4 === 1 (towersTick 7.3 vs ~4.8, _towerAcqKernels 5.1 vs ~3.2), the spawner production at % 4 === 2 (SPAWN_PROD 5.5 vs 1.5, processGlobalSpawnerQueue +4), the search post at % 4 === 3.

Tick 0 (1589 ms; 1291 earlier, same composition): the navigation's first build (NAV_CHAIN 439 ms; the simulation worker makes it before the match is reported started, sim_worker.js, the page-simulated bench does not), the opening orders on every unit (runQueuedOrders 381 ms), the first acquisitions and tower scans.

Tools for this kind of hunt (scratchpad copies of the chaos test, kept as recipes): hObj-vs-fields drift check; per-peer raw column dump of a region's units and structures; the region's hash split into all-slices total, static and unit parts; the slice-only parts (core sweep, reservation running sums vs a fresh sum, mine sums, tile code/val/tim).

Still to do in this rework (user: everything to wasm preparation / helper kernels, one command per user action, main thread applies only): resizeUnitSubgroup (q/e) as a kernel (subgroups by radix sort, survivors, stack and energy shares, spawn / retire lists; the bySub grouping is JS now); group spawn queue/dequeue as one command (queueGroupSpawns / dequeueGroupSpawns / count_bars send one per unit or building); multi-point move / attack-move / workerAssign as one command with per-point buckets (main.js applyUnitCommandTargets, assign worker); hold / stop / attack / attackBuilding / killUnit as kernels over the prepared slots; the preparation itself (id decode, tile packing) as wasm on helpers; the research queue in the wasm heap; pathfinding.js group-route budgets (GROUP_ROUTE_*_PER_TICK, MAX_PATHS_PER_TICK) removed with its conversion. Then benchmark, full tests, fix. Known failing before: multiplayer-recovery-order (tick 260), worker-fallback-upgrade (test slices pathfinding.js without _pendingPathDest).

## 2026-11-05: online unit-slot relayout (branch claude/gallant-shaw-b7cbef)

**Why.** Unit slots decay two ways: deaths leave holes (births refill them in
their block, so this matters most after large die-offs), and units walk out
of the 16x16-tile block their slab was given (generic: any moving army). Every
slot-ordered pass (movement stage 1, occupancy by block, status, marks,
acquisition snapshot, spatial counts...) then reads lines it does not need.
The 1M chaos scene at tick 60: 0.23 density (240k units over 1.11M slots),
only 5-12% of units standing in their slab's block. A one-off compaction (the
restore) measured 114 -> 94 ms there; this makes it continuous.

**Design (all per-unit work in kernels, nothing per unit in JS).**
- A step at a tick's end (main.js, before the index prebuild), every
  `SIM_RELAYOUT_EVERY` (2) ticks, moving at most
  `live * EVERY / SIM_RELAYOUT_PERIOD` (1/256) units.
- `k_relayout_plan` (nfs.rs, one job): from per-slab scores (living units,
  units standing in the slab's home block) picks, cheapest first: tail slabs
  past the slabs in use + 1/16 (whole into the lowest empty slab, same
  offsets), drifted slabs (most units out of their block), a block's sparser
  slabs while it holds more than its units need; each unit to a hole of its
  current block's slabs (else the lowest empty slab, given to that block).
  Updates the allocator's books (now heap arrays), trims the tail, relists.
- `k_slot_move`: every heap column copied from -> to, `from` left as a fresh
  slot (k_slot_zero's defaults); sepKey/layer, occ.rec; the handle table;
  the forward map (stamped per step, never cleared); pvS reset; the id hash
  table's and id table's entries of the moved units (probe / binary search).
- `k_slot_remap` (over slots): tuS, cmT, the pending wheel's links, the
  order ring, the wheel's heads; computes the next step's slab scores in the
  same pass (`k_slab_score` only when they are stale).
- Unit handles: a unit's slot is `columns.hslot[unit._h]` (`_si` is a
  prototype getter); `owners` is a view (`owners.at(slot)` = objects by the
  slot's `hnd` column). A move writes no JS object.
- JS-only unit fields: the 15 numeric ones are heap movement columns (alias
  table); small-value references (stat tables, flags, worker type,
  `pathIsFallbackAstar`, `holdPosition`) are shared-id columns whose id arrays
  are in the slot table; `_astarBudgetRetryTick` a Float64 heap column; true
  object references (`_path`, `_fpPath`, `_ppt`, `attackTarget`) are keyed by
  handle (`SimHandleRefColumn`), so they never move. The presentation's
  metadata table is in the heap and in the slot table; the presentation
  worker's drawn state follows the moves (`slotMoves`, pairs only).
- In-flight tier results: acquisition results are replayed at the commit
  (`k_acq_replay` + `k_acq_remap` from a heap log), worker-search requests
  resolved by id at their commit, healer lists by id. Steps skip only while
  the index prebuild, the tick lane or the hash lane are pending.

**Results (1M start, 11 helpers, dk1, `--worker-post --no-census`, 300 ticks,
settled 240; serial).**

| run | mean | p50 | p95 | p99 | max | simMoveRun | slots at end |
|---|---|---|---|---|---|---|---|
| off (m6-off) | 101.6 | 99.0 | 124.9 | 132.8 | 144.5 | 56.6 | 1.11M |
| on (m7-on) | 94.6 | 93.6 | 117.3 | 129.4 | 146.1 | 50.3 | 517k |

Step cost (every other tick): move kernel 2.4 ms, remap 1.2, score 0.8 (when
stale), plan + glue ~0.6; ~2.5 ms/tick averaged. Status prepass 3.1 -> 2.3,
kernel:24 2.8 -> 2.0, kernel:85 3.4 -> 2.5 (fewer slots). Density at end
0.50, 15% of units in their slab's block. Raw: `tests/test-runs/relayout-20261105/`
(m*.json, cmp.cjs, m1.sh; steps' phases as SUBPHASES).

**Found and fixed on the way (cross-peer desync risks):**
- `k_combat_brain` kept a dead target read past the acquisition snapshot's
  slots (stale ids beyond n after the tail shrinks; a restore can do the
  same): bound check like the order branch.
- `simUnitStateCompact` with a unit listed twice copied the wrong slot.

**Open (next):**
- **Layout dependence still present:** with relayout on, the 1M scene's
  state diverges from off from tick 3 (per-tick `snapTickHash`), i.e. since
  steps also run while acquisition/worker-search results are in flight. A
  restored or joining peer has another layout, so this is a desync risk.
  Steps with those lanes gated (one tick in four) matched for 300 ticks after
  the brain fix. Next: find the part (per-part hash diff at tick 3, tools in
  the run dir: trace-*.js, m1h.sh).
- Determinism tests (multiplayer chaos with host-only stress, chaos scenario,
  slot tests) passed before the handle/heap conversion; rerun after it.
- p95+ is mostly the bench's command bursts (processActions 15-26 ms) and the
  tick after (movement +15 ms while new orders arm), plus the acquisition
  post's 5 ms snapshot (smaller now with half the slots).
- Only 15% of units stay in their block: armies outrun a 1/256 budget. The
  move kernel (~1.3 us wall a unit, ~240 columns) is the cost to cut next
  (column diet / AoS for co-read columns).
- WASM64 (legacy) not kept current for these kernels: the relayout turns
  itself off without them.

## 2026-11-05: in-game GC (worker post, presentation pump), acquisition stages

### Benchmarking what the browser worker actually does

- The headless benchmark ran the page's local presentation (alerts, effect
  records, sounds) and none of the worker's per-tick result post or the
  presentation thread's metadata pump. New `--worker-post` installs the real
  `sim_worker.js` recorders (`_simStubUi`: packed events), starts the
  presentation reader with a no-op Worker, runs `simPresentTickEnd` and
  `_simPostResult` inside the tick timing (the post itself dropped) and a
  pump pass every 5 steps outside it (the harness clock is virtual, so one
  call runs a whole metadata pass, not a 1 ms slice).
- New `--no-census`: skips the harness's 10-tick worker census, which alone
  produced ~72 MiB of scavenge survivors per 100 ticks (most of the
  benchmark's 10 ms scavenges were copying harness data).
- New `--allocation-survivors` (sample only objects that survived a
  scavenge), `--live-heap` (live JS heap by allocation site at the end,
  sampled from before match start) and `--restore-at=N` (diagnostic: full
  state encode/decode in place before step N, which compacts unit slots).
- `--trace-gc-nvp` showed steady scavenges spend ~3 ms on the main thread and
  the rest waiting for V8's parallel scavenge tasks; pause length follows the
  surviving bytes (~3 MB survived + ~3 MB promoted ≈ 7 ms), not garbage volume.

### Fixes (all in-game paths)

- Presentation metadata pump (`simPresentationMetadata`): `for…of` over the
  structure lists inside the generator allocated an iteration result per
  structure (~5 MB a pass at 65k structures); `F['l'+k]` built key strings
  four times per structure (`_simLinkSlot`, named columns now). The pump
  went from ~270 to ~29 MiB per 100 ticks in the benchmark's cadence.
- `_snapFloorItems` copied the whole floor-item list on every call, and the
  list was rebuilt whenever any tile changed; the tick hash (every tick in
  multiplayer) and the presentation lists took that path. New
  `_snapFloorItemsView`: maintained from the tile journal
  (`tileEntityChangesSince` + `_tileOrderedReplaceMany`), replaced only when a
  floor item changes, never mutated; `_snapFloorItems()` still returns a copy
  for callers that keep or reorder it.
- `_simDeltaEvents`: no Map, key strings or slices per player per tick (reused
  maps, callbacks without closures). The worker's A*/energy logs are emptied
  once their sums are sent (only page UI reads those logs), so their entries
  die young instead of surviving the log window.
- `_simEvTake`/`_simEvPosted`: the event string/extra lists are reused (the
  post clones synchronously). `_simTick` skips the per-team filter without
  actions.
- Research queue encode: a move (task to the front) failed the prefix match
  and deep-copied the whole ~1,600-task tail every burst. New run form
  `{__qr: [start, len, ...], tail, np}` reuses the last queue's tasks by
  runs; page decoder in `pageApplyState`. `player-state-delta.test.cjs` now
  mutates larger queues with moves (638 run deltas, 3,198 prefix deltas).
- Structure stat-entry misses no longer build `'barrack_'+unitType` strings.

### In-game GC result (1M/65,536 structures, 11 helpers, dk1, 340 settled ticks)

| | before | after |
| --- | ---: | ---: |
| GC events | 54 | 12 |
| total GC | 240.2 ms | 108.4 ms |
| longest pause | 76.6 ms (memory reducer) | 27.1 ms |
| major GCs | 4 (129.6 ms) | 2 (46.0 ms) |

Same population (220,401–376,010 live) and work. In-game survivors (tick +
post + pump stacks) fell from ~55 to ~10 MiB per 100 ticks. Raw data:
`tests/test-runs/gc-ingame-20261105/` (`base-long`, `fix1-long`, nvp logs,
`surv*`, `alloc*`, `live.json.liveheap`).

- Remaining: major GCs (evacuation of fragmented old space; ~305 MiB live JS
  heap: areas ~73 MiB + ~40 MiB distance caches, the grid's 1M cell objects
  ~60 MiB, structure-table JS arrays ~31 MiB, unit objects/slot arrays ~40
  MiB) and diffuse per-unit survivors (paths and nav nodes, sparse-field Map
  entries, new Unit objects). Flat stat-entry getters return boxed doubles.
- The page's own GC is separate and was not measured here.

### Acquisition tier: parallel area build, one seed pass a team

- Every 4th tick (the acquisition post) was ~+9–15 ms. `k_acq_area_build` ran
  as one serial chunk over ~350k entries, and each of the 8 structure-answer
  jobs rescanned all 1M tiles. Now: `k_acq_area_count` / `_prefix` /
  `_scatter` (up to 24 entry ranges, stable range-major order, same table)
  and `k_acq_area_seed` (one tile pass a team, four class seeds); the answer
  jobs only spread (P[35] 1). Full exact state hash unchanged on a 131k-unit
  scene (`560a4cff`); mixed replay 0/3 helpers passes.
- Measured (serial, both orders): occupancy growth on post ticks fell
  (8.3/6.8 → 5.4/5.6 ms), but the post-tick wall overhead stayed ~12–15 ms;
  the rest is the snapshot (`k_acq_snap`, ~5 ms, a memory-bound copy over all
  1.15M slots) and later waits. Machine noise between runs was ±4 ms.

### Tried and reverted

- Holding helpers off background chunks during the move kernel and the four
  occupancy phases: movement −1.7 to −3.9 ms, but the deferred background
  work then appeared as waits later in the tick (`unitEventsRun` +1.4 ms,
  waits +0.9 ms); net unchanged.

### Where the tick goes (named profile, 81 settled ticks)

- Main thread: ~80 ms/tick in WASM with ~10 of 11 helpers busy, ~26 ms JS
  (4 ms of it barrier spin) with ~6.5 busy: CPU-throughput bound
  (~1.1 s CPU per tick on 12 threads). Movement is ~45% of all CPU.
- Thread scaling (same deterministic scene): move thread-ms 177 (4 threads)
  → 204 (8) → 250 (12); occupancy 217 → 285 → 347. ~2,000 cycles per live
  unit per pass even at 4 threads.
- Occupancy counters (`--features=prof,dbgc`, main-thread share): nearly every
  live unit resolves through `checked_traffic_q` each tick, ~3 `motion`
  probes per resolve, ~27% need axis/shoulder retries, few end fully blocked.
- Slot fragmentation: after the first 60 ticks 16.3k of 16.5k 64-slot slabs
  hold live units at 16–23 live each (deaths are spread evenly); live units
  fill ~30% of the 1.06M slot range every slot-ordered pass reads.
- Slow ticks: bursts (+15–20 ms, `processActions`), the ticks just after a
  burst (movement +15–36 ms), acquisition posts (+12–15 ms), major GCs.

### Slot density experiment and a restore divergence (open, next)

- 524k-start scene (same flags, 11 helpers), `--restore-at=40` packs 331k
  live units from 577k slots into 331k: `simMoveRun` 31.3 → 25.1 ms (move
  kernel −1.95, each occupancy phase ~−0.9 ms), status/kernel 24 −0.5 ms
  each. The 1M scene runs at ~30% density, so an online, deterministic slot
  relayout (dense, spatial order, incremental) is the largest locality lever
  found: `frag-a.json` / `dense-b.json` in `tests/test-runs/tps-20261105/`.
- **Open bug:** that restore is not state-preserving at this scale. Hashes
  `44c7f82d` (none) vs `9643a0bd` (restored); live units differ from the first
  tick after (330,589 vs 330,942), and `recalculateUnitEffectiveLevel` jumps
  to ~50 ms a tick, decaying over 100+ ticks. Either outcomes depend on slot
  order or the restore drops staggered stat state. A large multiplayer
  resync would leave the patched peer diverging and dip TPS for seconds. Fix
  before any relayout (layout must not change outcomes).
- **Update (same day, restore divergence session):** causes found and fixed
  (uncommitted, WASM32 rebuilt):
  1. `simUnitStateCompact` left slot-keyed state behind: occupancy footprint
     records `occ.rec` (47k of 94k units walked from another unit's
     footprint: the "teleport"), `cmT` brain targets (tiles under cmMode 16
     are not remapped), pending acquisition/brain results (`acqTierRemapSlots`),
     worker-search requests (`ws.rslot`) and healer-scan lists/ids. Now
     remapped by the compaction.
  2. Order by slot: `k_ws_order` now radix-sorts the commit's requests by
     unit id (its comment already claimed id order); `k_spawn_select` gives
     newly ready spawners their ready orders by tile, not table row (a
     restore re-lays rows out).
  3. Effective stats: the resync flush and decode cleared `esOk` for every
     unit (`effStatsInvalidateAll`, and `initSpatialHash` on decode), so all
     units took the JS full path for a whole period (the 2→50 ms burst). The
     flush no longer invalidates; `initSpatialHash` clears only if type
     indexes changed; `esOk/esRad/esType` are sent (`SIM_UNIT_KCOL_FIELDS`:
     units behind their tables keep a stale range on purpose). Rules
     revision 56.
  4. Kernel/full-path twin bug in `k_eff_units`: the kernel clamped
     `count*stacks` to ≥1, JS clamps the count: a unit in an area with none
     of its kind in the period's snapshot got 1 stack / level 1 in the
     kernel but its base stacks via JS. Fixed (count ≥ 1, f64 maths).
- Reference: a restored peer is compared with an unrestored one that also
  runs the resync flush (`snapFlushHistoryCaches`, as every MP peer does at
  the flush tick). Decode without flush vs no flush can never match (decode
  drops every history cache by design). Bench: `--restore-at=N` now does
  encode+decode+flush; new `--flush-at=N` is the unrestored peer; `RESTORE_JS`
  env overrides. Raw: `tests/test-runs/restore-20261105/`.
- 5. (Found after the above, pre-existing, the last 524k divergence.) The
  healer candidates' scan copied `unit.owner` (Int8 since the column diet)
  into `hc.o`, an Int16 array, by the heap copy's bytes: every copied
  owner was made of two slots' bytes, so the damaged-unit lists per owner
  were garbage (owner 1's units listed for owner 0, the true lowest ratios
  missing) and changed with the layout; healers then backed off
  (`wsFail`) differently and were selected at other posts (tick 73 → 113).
  `hc.o` is Int8 now (JS and `k_heal_cand`), and `simParallelCopyHeap`
  throws on pairs of different element types (its heap path copies bytes).
  Healers now see the real most-damaged units: a behaviour change.
- Results (serial, 11 helpers, dk1, restore/flush/compaction before step 40):
  - 131k/512 scene: compaction = none, restore = flush, bit-exact.
  - 524k/1024 scene, 160 ticks: none `f35d9ec9` = compaction `f35d9ec9`;
    flush `c76b93ca` = restore `c76b93ca` (per-tick unit and exact hashes
    compared too). Restore 13.2 s (encode+decode outside the timing).
  - Effective levels after the restore: mean 1.90 ms (none 2.07); one
    32 ms tick right after the decode (base entries made anew), no burst.
  - Ticks 42–160 (mean / p99 / max): none 68.1 / 103 / 130; flush 68.5 /
    106 / 129; restore 62.5 / 105 / 107; compaction 58.9 / 91 / 92.
    `simMoveRun` 31.4 (none) → 25.1 ms (compaction). Dense slots are worth
    ~9 ms a tick here; the earlier dense-b figure was confounded by the bug.
  - The flush tick itself: 866 ms (flush) / 983 ms (restore) vs 96 normal.
  - Raw: `tests/test-runs/restore-20261105/` (s524-*.json, logs, tests.txt).
- 6. Why the 1M-start scene's restore never finished (measured: not GC; JS
  heap ~1 GB, mutator 95%; `--prof` of the decode, `prof1m/prof.txt`):
  - 65% of ticks: `actionEarlyRestore` → `_unitByIdMap` → `UnitIdIndex._refill`.
    With the wasm heap full the id table was made outside it, and `_ok()`
    rebuilt it from every unit whenever it was outside the heap: once per
    `set`, O(n²). Now only a table that was in the heap and is no longer
    (a new heap) is rebuilt; `_uixRoom` had the same pattern (fixed alike).
  - 17%: `_simSlabClaim` → `_simSlabFresh` → `_simUnitStateGrow`: the
    restored units were planned in fresh slabs past the old units' 1.11M
    slots, and with the heap tight `_simUnitCapThatFits` grew the columns a
    few slabs at a time, each a full column copy; then the compaction made a
    second full set. New `simUnitStateReleaseAll` (called at a whole decode's
    unit list): every old unit detached (as the collection after would), the
    allocator from slot 0 (slots marked used-before, columns zeroed then
    defaulted), so the restored units take the reservation's slots by plan
    and the compaction finds them laid out. No column growth or copy at all.
  - The id index's loose map kept the released old units reachable (~700 MB
    at 524k); `_refill` now rebuilds it from the list, a list replacement
    empties it. They are collected during the next ticks instead (the
    restored peer's major GCs up to 88 ms vs 63 ms on the flush peer).
  - 1M-start scene now (435k live in 1.11M slots, restore before step 40):
    encode 6.4 s, decode 9.4 s, flush 0.4 s (was > 50 min); flush-only and
    restore both `879235c` at step 60 (bit-exact). Ticks 42–60: mean 114.3 →
    93.9 ms, `simMoveRun` 58.3 → 39.9 ms on the dense layout.
  - 524k after this: flush = restore `c76b93ca` again (160 ticks), restore
    12.7 s, cap kept at 577,536 (no second column set).
- Tests (after all changes, run twice, last after the id-index change):
  player-state-delta, solo-snapshot, multiplayer-snapshot,
  lockstep-hash-stream, chaos-scenario-determinism (0/3 helpers),
  multiplayer-chaos-determinism with 0 and 4 host helpers (2,598 hashes per
  map, only forced patches): all pass. WASM32 `4de2952132a1de9e` (WASM64 not
  rebuilt). New bench option `RESTORE_SPLIT=1` times encode/decode/flush.
- **Still open:** (a) the resync flush tick costs 220–980 ms on every peer
  (131k: pop caps 42, navTick 33, kernel 135 45, `_wswBuild` 15, worker
  events 20 ms): a resync spike to fix. (b) flush→decode order
  (`applyAuthoritativeStateSnapshot`) ≠ flush alone; harmless there because
  every peer, host included, restores the same text. (c) Decode without the
  flush cannot equal no restore (decode drops the history caches by design).
  (d) The restored peer's old Unit objects are garbage the GC collects over
  the next ticks (longer major GCs there); a restore without per-unit JS
  objects would remove it. (e) One ~32–40 ms effective-levels tick right after
  a decode (base entries made anew).
- Restore cost: ~37 µs a unit in JS (row encoding, shells, Unit objects); 1M
  scene (380k live in 1.06M slots) did not finish in 40 min (cause and fix:
  item 6 above).
- Validation for this entry: player-state-delta, chaos-scenario-determinism
  (0/3 helpers), presentation-worker, research-menu, local-visual-snapshot,
  solo/multiplayer snapshot, pooled-structure and row-expiry snapshots,
  lockstep-hash-stream, multiplayer-chaos-determinism with 0 and 4 host
  helpers (1,398 hashes per map, only forced patches): all pass. Rebuilt
  WASM32 `a219b2e9bdf86add`, WASM64 `e0f2fceaf011fb18`.

## 2026-11-04: reuse damage alerts and remove fresh-spawn request sets

- Damage alerts read a target position only when adding a minimap
  alert or playing a sound. The map keeps its 40 reserved records
  through overwrite, expiry and reset. Kernel attack presentation
  shares numeric impact coordinates between effects and sound.
- A fresh spawned unit can request its rally path once. The spawn
  path records the same solo budget accounting without building and
  clearing per-player sets of requester IDs.
- The focused visual check covers capped alerts, king-alert eviction,
  suppression without position reads, expiry and reset. The mixed
  replay, combat effects, event codec, local visual snapshots, combat
  reach, production pass and routing checks passed. Raw data are in
  `tests/test-runs/gameplay-gc-effects-20261104/`.
- Across 100 settled ticks, the final allocation sample was 34.50
  MiB after subtracting tagged benchmark instrumentation, versus
  38.40 MiB after the research batch and 42.71 MiB before it. The
  unadjusted totals were 39.75/42.83/46.99 MiB. The alert path
  including callees went from 2.13 to 0.03 MiB, attack effects from
  1.00 to 0.34 MiB and the full unit-hit resolution subtree from
  7.07 to 4.73 MiB. The spawn path requester Set went from 0.25
  MiB to no samples. Synthetic input generation and other harness
  activity sampled 183.36 and 84.72 MiB. The headless benchmark
  executes local presentation, so these alert results do not
  measure browser worker transport or replay timing.
- The final long comparison matched hash `70202b6e`, live population
  220,401–376,010 and all gameplay work over 340 settled ticks. The
  original reference recorded eight minor, one incremental and one
  major GC event over 47.26 s. The final run recorded nine minor
  events over 42.02 s. Total GC time fell from 87.13 to 84.16 ms,
  while time per second rose from 1.84 to 2.00 ms/s. These runs do
  not establish a reduction in GC time per second.
  Wall mean/p95/p99/max fell from 107.42/137.97/163.32/194.03
  to 95.73/119.03/133.42/144.44 ms. Ticks above 1.5× median
  were 5 → 1 and none exceeded 500 ms. Spawns, research, collector
  and A* deposits per timed wall second were 714.7/245.4/88.8/61.1
  → 801.9/275.3/99.6/68.6.
- The final 12-thread capture's previous/GC/next/same-burst
  reference ticks 149/150/151/140 took 119.3/124.1/97.8/135.3 ms.
  GC accounted for 10.1 ms of tick 150's 10.5 ms yield gap, with
  movement and worker search on the helpers. The worst wall tick
  was 110 at 209.6 ms with zero GC. Its previous/next/same-burst
  reference ticks 109/111/120 took 115.8/116.0/133.7 ms.
  Command processing rose to 69.4 ms from 24.0 ms on tick 120.
  The main profile sampled action arrival recording and kernel waits,
  while helper samples included movement. Track this separately from
  GC. Remaining allocation samples include unit-hit presentation,
  generic kernel dispatch and A* usage logging.

## 2026-11-04: reuse research lookups and worker AI preparation

- Adjacency prebuilds the five research IDs for each stat key and reads
  the owner's level record once when packing. Preview uses the existing
  research lookup. Static building packs skip the key walk on cache hits.
  Research catalogue lookups use a kind/key index, and stat lookup walks
  the list without a callback.
- Worker work versions and AI stat tables compare numeric dimensions
  directly. Worker AI reuses the stat probes and uses stable column names
  and helpers during packing. Worker search and AI now share the
  class-column packer.
- The wrapper-adjusted allocation capture over 100 settled mixed-chaos
  ticks fell from 42.71 to 38.40 MiB (46.99 → 42.83 MiB with wrappers).
  Adjacency player stats fell from 1.41 to 0.09 MiB, worker AI dispatch
  including callees from 3.36 to 0.66 MiB, and research task normalization
  from 0.78 to 0.03 MiB. Worker work-table lookups had no samples, down
  from 0.69 MiB. These subtrees overlap. Synthetic inputs and other
  harness activity sampled 183.09 and 86.81 MiB in the candidate.
- The serial long comparison matched hash `70202b6e` and work across
  340 settled ticks with 11 helpers, WASM32, dk1 and 220,401–376,010
  live units. Direct GC events were 10 → 8 over 47.26 → 43.63 s.
  Both had eight minor events. The reference also recorded an incremental
  event and a major event. Total runtime GC time was 87.13 → 71.57 ms
  (1.84 → 1.64 ms/s). Wall mean/p95/p99/max was
  107.42/137.97/163.32/194.03 → 98.22/120.82/139.79/154.07 ms,
  with 5 → 2 ticks above 1.5× median and none above 500 ms.
  Spawns, research, collector and A* deposits per timed wall second
  were 714.7/245.4/88.8/61.1 → 781.6/268.4/97.1/66.9.
- The 12-thread CPU capture's previous/GC/next/same-burst reference
  ticks 89/90/91/80 took 119.3/141.5/124.3/138.4 ms. Tick 90 had
  10.8 ms of GC. Its movement phase took 62.3 ms, close to tick 80's
  62.5 ms. Main samples included GC and movement, with helper
  movement and background claims. The worst wall tick, 105, had zero
  GC and took 159.4 ms versus 117.9/145.0/114.1 ms on ticks 104/106/86.
  Movement expanded to 101.4 ms versus 61.2 ms on the same-burst-status
  reference. The main thread sampled barriers and helpers sampled
  movement and acquisition.
- Research queue, partial rebase, boosts, shared-stat snapshots, worker
  search, collectors, worker snapshots and mixed replay passed. Replay
  matched all 65 hashes with 0 and 3 helpers. Raw data are in
  `tests/test-runs/gameplay-gc-research-20261104/`.

## 2026-11-04: remove movement dispatch temporaries and reserve worker free records

- After the command batch, the generic Rust and movement dispatch
  wrappers sampled 1.96 and 2.10 MiB. Movement now uses stable
  binding names and avoids creating a length-lookup closure. The
  experiment also cached the generic kernel's encoded pointer words
  and removed its oversized-parameter view. Movement had no samples
  in the experimental capture, while generic dispatch sampled
  2.04 MiB. The final code keeps the movement change and drops the
  generic experiment.
- Individual heap samples showed two large allocations in retirement
  of 915,752 and 1,373,760 bytes, with sizes repeating across captures.
  These pointed to the worker-record free list, the growing JS array
  in the worker detachment path. Worker-record capacity now also
  reserves a typed free stack, at four bytes per reserved record,
  with the same LIFO reuse order. The focused retirement check verifies
  that a worker record is returned without replacing the stack.
- Over 100 settled ticks, sampled retirement including callees fell
  from 2.25 to 0.16 MiB. The two large samples disappeared from the
  retirement stacks. Movement dispatch still had no samples with the
  generic experiment removed. Allocation under simulation stacks
  excluding tagged benchmark wrappers fell from 48.38 MiB before
  the order changes to 46.78 MiB after them and 42.71 MiB in the final
  capture. The corresponding unadjusted totals were 52.68, 51.56
  and 46.99 MiB. The final synthetic input and other harness totals
  were 183.38 and 82.26 MiB. The allocation report now includes sample
  counts and largest estimated sample sizes alongside grouped totals.
- The final remaining sites include native generic dispatch, research
  lookups in adjacency stat packing, worker AI preparation and local
  combat presentation in the harness. The largest remaining single
  sample under simulation stacks was 131,112 bytes under spawn
  completion. Keep the headless presentation stacks separate from the
  browser authority worker's costs.
- Retirement, slot zeroing, shared-state reuse, worker snapshots,
  worker spawner decisions, tower targeting and mixed replay checks
  passed. The mixed replay matched 65 hashes with 0 and 3 helpers.
  Raw data are in `tests/test-runs/gameplay-gc-dispatch-20261104/`.
- Against the fresh pre-order reference, the final code matched
  hash `70202b6e` and work over 340 settled ticks at 220,401–376,010
  live units. The continuous window was 45.19 → 46.58 s with
  9 → 8 minor collections and 75.15 → 70.87 ms total GC
  (1.66 → 1.52 ms/s). Wall mean/p95/p99/max was
  102.99/131.21/148.25/182.09 → 105.52/133.12/154.25/159.54 ms.
  Both had three ticks above 1.5× median and zero above 500 ms.
  Spawns, research, collector and A* deposits per timed wall second
  were 745.5/255.9/92.6/63.8 → 727.5/249.8/90.4/62.2.
  These latency measures are separate from the allocation comparison.
- The final 12-thread CPU capture's previous/GC/next/same-burst
  reference ticks 148/149/150/147 took 105.5/133.8/119.4/106.5 ms.
  GC accounted for 11.8 ms of tick 149's 12.1 ms yield gap. Movement,
  navigation and acquisition were prominent on the helper threads.
  The worst wall tick, 113, had zero GC and took 183.0 ms, versus
  117.3/134.3/103.7 ms on ticks 112/114/96. Movement expanded to
  111.4 ms versus 60.2 ms on the same-burst-status reference, with
  the main thread sampling the kernel barrier and helpers sampling
  movement, navigation and acquisition.

## 2026-11-04: reuse attack targets and pending-path scratch

- Attack orders sample their target coordinates once and reuse the
  resulting position for the action. Live units store its numeric values.
  The first capture also tested direct pending/fallback resets, which
  showed no allocation reduction in the reset itself. The final code
  keeps the existing setters for that reset.
- Pending-path retries read quantized positions directly for live unit
  slots, reuse the walkable-tile result and can keep an unchanged narrow
  path. The unchanged navigation-build check runs before position reads.
- Tower commands resolve and encode one target for the whole selection.
  Live tower target resolution reads the numeric target columns. The
  existing structure-target replacement rule and public spec accessors
  remain available and are covered by the tower kernel test.
- Over 100 settled mixed-chaos ticks, tagged-wrapper-adjusted allocations
  under simulation stacks were 48.38 → 46.78 MiB (52.68 → 51.56 MiB with
  wrappers). Command execution fell from 9.23 to 6.25 MiB and pending-path
  retries from 0.89 to 0.68 MiB. Tower target normalization and resolution
  had no samples in the candidate, down from 0.59 and 1.06 MiB in their
  overlapping reference stacks. Synthetic input and other harness activity
  sampled 184.56 and 83.86 MiB in the candidate.
- Over 340 settled ticks (60–399, WASM32, 11 helpers, dk1), hash
  `70202b6e`, gameplay work and live population 220,401–376,010 matched.
  Direct GC records showed nine minor events each. Total GC was
  75.15 → 81.66 ms over 45.19 → 43.50 s (1.66 → 1.88 ms/s).
  Wall mean/p95/p99/max was 102.99/131.21/148.25/182.09 →
  97.67/120.08/127.68/137.70 ms. Ticks above 1.5× median were
  3 → 0 and none exceeded 500 ms. Spawns, research, collector and
  A* deposits per wall second were 745.5/255.9/92.6/63.8 →
  786.1/269.9/97.6/67.2. This timing pair included the experimental
  direct attack reset. Raw data are in
  `tests/test-runs/gameplay-gc-orders-20261104/`.
- The 12-thread profile's previous/GC/next/same-burst ticks
  69/70/71/80 took 119.2/136.5/109.1/124.1 ms. GC accounted for
  10.5 ms of tick 70's 10.9 ms yield gap. The main thread sampled
  GC and movement, and helpers mostly sampled movement with tile
  owner and visibility work. The slowest wall tick, 60, had zero
  GC. Previous/next/same-burst reference ticks 59/61/70 took
  126.0/136.9/136.5 ms versus 145.2 ms at tick 60, where command
  execution took 24.8 ms and main and helper profiles sampled slot
  zeroing.
- Tower targeting, fast order parity, order supersession, path
  routing and mixed replay checks passed, including 65 matching
  hashes with 0 and 3 helpers.

## 2026-11-04: reuse spawn production scratch

- The next profile pointed to the production subtree. Production now
  writes its job records directly into the reserved typed array and
  reuses selection and shift arguments and the blocked-spawner list.
  Spawn-stat template misses reuse the before-image scratch and cache
  the column names per column store. Template results keep owned data.
- Over 100 settled ticks, the production subtree sampled 9.21 → 7.81
  MiB, including production scheduling at 1.00 → 0.25 MiB and stat
  templates at 1.43 → 0.50 MiB. Total simulation-stack samples were
  53.32 → 53.52 MiB. Synthetic inputs and harness/other were 182.35
  and 86.96 MiB in this capture.
- Over 340 settled ticks, the same population range (220,401–376,010),
  work counts and hash `70202b6e` matched. Direct GC records showed
  nine minor collections in each run, 74.97 → 84.10 ms total across
  42.73 → 45.87 s (1.75 → 1.83 ms/s). Wall mean/p95/p99/max was
  97.90/124.88/144.31/165.35 → 103.74/136.57/165.38/238.96 ms.
  Ticks above 1.5× median were 4 → 9, and none exceeded 500 ms.
  The longest wall ticks 234 and 235 had zero GC. Mean production
  phase was 2.98 → 3.25 ms, while movement was 57.50 → 60.35 ms.
  Spawns, research, collector and A* deposits per timed wall second
  were 784.2/269.2/97.4/67.1 → 740.1/254.1/91.9/63.3.
  The nearby non-burst comparison for tick 234 was tick 229.
  Previous/slow/next/reference ticks 233/234/235/229 took
  165.1/239.0/226.9/120.7 ms, all with zero GC. Movement took
  91.4/147.3/150.8/78.9 ms. As with the earlier 320 ms tick, this
  unprofiled stretch showed more elapsed time with lower process CPU
  on its slowest ticks. Its exact cause remains open.
- Spawn production, spawn column parity, structure table and mixed
  replay checks passed, including 65 matching hashes with 0 and 3
  helpers. Raw data are in
  `tests/test-runs/gameplay-gc-production-20261104/`.
- The repeated capture sampled 52.68 MiB under simulation stacks,
  including 4.30 MiB attributed to tagged benchmark wrappers. Of
  that wrapper total, 1.31 MiB was the spawn counter. This leaves
  48.38 MiB under simulation stacks after subtracting tagged
  instrumentation. Synthetic inputs and other harness activity
  sampled 180.78 and 81.49 MiB. The capture resolves eval script IDs
  before allocation sampling and disables the debugger for gameplay.
- Remaining sampled sources include boxed coordinates in the order
  and pending-path paths, native dispatch (3.50 MiB across the two
  main wrappers), retirement (2.18 MiB across the pass and detach),
  and local combat presentation in the headless harness. Investigate
  the concrete allocations in those stacks before changing them.
  Neither a high wall tick nor the longest GC event identifies the
  allocation that triggered collection.

## 2026-11-04: reuse worker and structure-hit arguments and narrow routes

- Prioritized the next batch from the refreshed allocation stacks. The
  preceding capture sampled 3.73 MiB under worker AI dispatch, 3.02 MiB
  under structure-hit dispatch and 2.16 MiB under reachable path creation.
  Worker AI and structure hits reuse their ordered native argument arrays.
  The structure-hit class walk also reuses its static column names. A
  comparison with the reference confirmed all 156 worker ABI argument
  expressions kept their positions.
- Move-order fallback and spawner rallies reuse an existing narrow route
  when its profile, destination and ready time still match. Each call
  still performs its reachability check and requests its navigation
  field. The move-order fallback reuses a tile coordinate record within
  the order. Background dirty marking reuses its clamped rectangle and
  keeps owned bounds where the renderer holds them past the call.
- The first direct GC comparison used 340 settled mixed-chaos ticks
  (60–399, WASM32, dk1, 11 helpers). Both versions matched hash
  `70202b6e`, live population 220,401–376,010 and gameplay work.
  Across 44.10 → 42.73 elapsed seconds, both recorded nine minor
  collections. Total GC was 75.86 → 74.97 ms, the longest was
  11.28 → 10.55 ms and GC time per second was 1.72 → 1.75 ms/s.
  Wall mean/p95/p99/max was 101.02/122.87/132.83/181.28 →
  97.90/124.88/144.31/165.35 ms. There were 1 → 4 ticks above 1.5×
  median and zero above 500 ms. Rates for spawns, research, collector
  and A* deposits were 760.0/260.9/94.4/65.0 →
  784.2/269.2/97.4/67.1 per timed wall second.
  Raw data are in `tests/test-runs/gameplay-gc-native-20261104/`.
- The next allocation capture sampled 53.32 MiB under simulation stacks
  over 100 settled ticks, down from 60.67 MiB. Structure-hit dispatch
  including callees fell from 3.02 to 0.03 MiB, reachable path creation
  from 2.16 to 1.06 MiB, and background rectangle marking from 1.00 to
  0.19 MiB. Worker AI dispatch fell from 3.73 to 3.32 MiB and spawn
  completion from 6.38 to 4.98 MiB. These subtrees can overlap.
  Synthetic inputs and harness/other sampled 181.40 and 84.80 MiB.
- In the 12-thread CPU capture, previous/GC/next/same-burst reference
  ticks 99/100/101/120 took 100.8/136.9/128.1/137.1 ms. The collector
  accounted for 10.5 ms of tick 100's 11.0 ms yield gap. Its movement
  phase was shorter than the same-burst reference's. The slowest
  wall tick 110 had zero GC and took 177.0 ms, versus 124.3/120.5/
  136.9 ms on ticks 109/111/100. It showed more movement and queued
  order work. Helper slices showed movement throughout, with navigation
  and acquisition activity prominent on some neighboring ticks.
- Mixed replay, order supersession, mixed rally, production, worker
  spawner decisions, collector farms, towers, floor traps and structure
  table checks passed.

## 2026-11-04: avoid repacking building stats and allocating spawn coordinates

- Prioritized full allocation stacks over grouped leaf names, which can
  conflate different callers. The preceding settled capture sampled
  2.19 MiB in tower stat getters during packing, 0.91 MiB in the worker
  adjacency packer's research-level lookups, and 0.88 MiB in order
  supersession iterator results. Spawn completion and rally lookup
  appeared across several stacks.
- Tower and worker adjacency packs now invalidate on building-stat
  changes, full rebuilds and snapshot restoration. Unit-only research
  and boosts no longer invalidate them. The worker class-column loop
  uses fixed property names and no callback. The final tower pack
  refreshes only the affected owner and building key on a targeted
  building-stat change, and keeps the cached ranges of the other rows.
- Spawns reuse the exit coordinate record, use numeric rally coordinates
  directly and refresh existing path-template records. The public rally
  lookup and ordinary nearest-walkable callers still get owned results.
  Order supersession walks immediate arrays by index and uses native Set
  traversal for ordinary Sets, with the iterable path as a fallback.
- The first candidate's capture sampled 62.13 MiB under simulation
  stacks, versus 65.36 MiB in the preceding pass. Spawn begin and end
  fell from 3.43/6.94 to 2.61/5.33 MiB including callees. The worker
  adjacency stats pack fell from 1.66 to 0.97 MiB, and order
  supersession fell from 0.88 to 0.13 MiB. Tower packing fell only
  from 2.22 to 2.10 MiB, prompting the narrower invalidation above.
- Initial serial pairs used WASM32, dk1, 11 helpers, settled ticks
  60–159 and 285,916–376,010 live units. All four matched hash
  `f8162538` and gameplay work counts. Each had three GC-overlap
  ticks and zero ticks over 500 ms. These pairs precede per-row
  invalidation.

  | Run | Wall mean | p95 | p99 / max | Ticks >1.5× median | GC overlap / longest |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 100.76 ms | 118.98 ms | 129.70 ms | 0 | 26.27 / 9.93 ms |
  | Candidate A | 99.44 ms | 120.45 ms | 138.07 ms | 0 | 26.58 / 10.33 ms |
  | Candidate B | 102.12 ms | 126.39 ms | 140.23 ms | 0 | 27.71 / 9.87 ms |
  | Reference B | 126.03 ms | 199.22 ms | 319.84 ms | 7 | 28.87 / 10.40 ms |

  Reference B's 319.84 ms tick had zero GC and wider phase delays.
  Per wall second, spawns, research deposits, collector deposits and
  A* deposits were 710.7/221.4/94.1/84.7 → 720.1/224.4/95.3/85.8 in A
  and 568.2/177.0/75.2/67.7 → 701.2/218.5/92.8/83.5 in B.
  Raw ticks and profiles are in `tests/test-runs/gameplay-gc-size-20261104/`.
- The final tower version's 12-thread CPU profile captured its largest
  GC overlap at tick 70. Previous/slow/next/same-burst reference ticks
  69/70/71/80 took 118.5/139.4/119.3/130.2 ms. The 10.75 ms collection
  accounted for nearly all of tick 70's 11.0 ms yield gap. Helpers were
  mostly in movement, with worker search sampled on tick 70. The
  slowest wall tick, 81, took 202.4 ms with zero GC. Previous/next/same-
  burst-status reference ticks 80/82/79 took 130.2/148.0/112.8 ms.
  Movement took 85.4 ms and effective stat refresh 44.4 ms on tick 81.
  Helper samples also showed navigation field work and acquisition.
- GC comparison now uses the runtime's timestamped events over a
  continuous interval, independent of tick duration. The settled interval
  starts at the first measured tick's timer and ends at the last yield.
  It includes synthetic input generation between those endpoints and
  harness activity. The short runs each had three minor collections.
  Direct GC time per wall second was 1.98 → 2.03 ms/s in A and
  1.77 → 2.06 ms/s in B. See `gc-short-summary.json` for raw event
  aggregates and `tests/chaos-gc-summary.cjs` for the command.
- Separate stall investigation for reference B: previous/slow/next and
  same-burst comparison ticks 79/80/81/90 took 157.2/319.8/186.4/124.5 ms.
  The slow tick was almost entirely inside the tick timer. Compared with
  tick 90, commands took 55.4 versus 17.9 ms, movement 108.9 versus 58.9 ms,
  and effective stats 28.2 versus 5.4 ms. Process CPU was 1.00 versus
  1.05 CPU-seconds across the threads despite the much longer elapsed time.
  That is consistent with waits or scheduling contributing to the delay.
  The reference was unprofiled, so the exact cause remains open.
- After per-row invalidation, the final short allocation capture sampled
  60.67 MiB under simulation stacks, versus 65.36 MiB before the batch.
  Tower packing fell from 2.22 to 0.38 MiB, order supersession from
  0.88 to 0.03 MiB, and worker adjacency stats from 1.66 to 1.06 MiB.
  Synthetic inputs and harness/other were 184.68 and 83.48 MiB.
  The final short unprofiled run recorded wall mean/p95/p99/max of
  106.10/133.85/152.83/152.83 ms, with three minor GC events totaling
  32.12 ms and a longest event of 10.98 ms. No tick exceeded 1.5× median.
- The final candidate and reference also ran 340 settled ticks
  (60–399, 220,401–376,010 live units, hash `70202b6e`, identical work).
  Runtime minor GC was 10 → 9 events, 89.66 → 75.86 ms total, and
  11.59 → 11.28 ms longest over continuous windows of 45.78 → 44.10 s,
  or 1.96 → 1.72 ms/s. Wall mean/p95/p99/max were
  104.37/138.61/162.52/187.54 → 101.02/122.87/132.83/181.28 ms,
  with 6 → 1 ticks above 1.5× median and none above 500 ms.
  Spawns, research, collector and A* deposits per wall second were
  735.6/252.6/91.4/62.9 → 760.0/260.9/94.2/65.0.
- Mixed replay matched 65 hashes with 0 and 3 helpers. Tower row
  packing matched forced rebuilds after boosts to two building types
  owned by different players. Boost, snapshot, supersession, trap,
  collector, production pass and mixed rally tests passed.

## 2026-11-04: remove recurring build, stat and A* log allocations

- Build-area checks walk the existing canonical cells by index and validate
  fallback cells in place. Structure destruction writes the class columns
  into its reusable native argument array and copies external tile lists
  directly into the existing input buffer.
- Effective-stat rows that already hold a clone of the current source are
  refreshed directly, preserving base max energy. Rows with different
  sources still use the compatibility path. The A* log reuses its type and
  source index for each live HUD bucket. It resets the index on clock
  rewind, and the movement kernel's usage totals pass the unit type
  directly without a temporary object. The actual HUD log rows still
  allocate.
- Serial WASM32 mixed chaos at dk1 used 11 helpers and 100 settled ticks
  (60–159), with 285,916–376,010 live units. Hash `f8162538` and gameplay
  work counts matched. The initial timing pairs preceded the A* clock
  rewind guard, which only resets the index on a rewind.

  | Run | Wall mean | p95 | p99 / max | Ticks >1.5× median | GC overlap / longest |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 108.62 ms | 132.54 ms | 151.27 ms | 0 | 30.53 / 11.65 ms |
  | Candidate A | 102.10 ms | 121.83 ms | 131.53 ms | 0 | 23.76 / 8.42 ms |
  | Candidate B | 100.95 ms | 125.05 ms | 155.71 ms | 1 | 25.80 / 9.66 ms |
  | Reference B | 104.38 ms | 122.70 ms | 217.02 ms | 2 | 26.72 / 9.56 ms |
  | Final candidate | 98.36 ms | 115.73 ms | 127.97 ms | 0 | 26.07 / 9.63 ms |

  Each run had GC overlap on three settled ticks and zero ticks over
  500 ms. GC overlap fell in both pairs, but the longest pause improved
  only in A. Spawns, research deposits, collector deposits and A* deposits
  per wall second were 659.3/205.4/87.3/78.5 → 701.3/218.5/92.8/83.5 in A
  and 686.1/213.7/90.8/81.7 → 709.3/221.0/93.9/84.5 in B. The final
  candidate with the rewind guard reached 728.1/226.8/96.4/86.7. Raw rows,
  allocation and CPU captures, and reference sources are in
  `tests/test-runs/gameplay-gc-next-20261104/`.
- The allocation capture with the rewind guard sampled 65.36 MiB under
  simulation stacks, down from 72.88 MiB in the preceding pass. Effective
  stat refresh including callees fell from 4.88 to 0.78 MiB, A* usage
  accounting from 2.04 to 0.74 MiB, and destruction class arguments from
  0.63 to 0.09 MiB. The build-area check went from 0.22 MiB to no samples.
  Synthetic input and harness/other samples were 185.55 and 83.64 MiB,
  compared with 183.11 and 83.24 MiB. The simulation category includes
  instrumentation nested within tick calls.
- Remaining sampled gameplay sources include native kernel dispatch,
  stationary stat access, unit retirement and queued-order supersession.
  The harness also runs local damage visuals. This run does not measure
  allocations or GC in the browser's presentation and transport code.
- In the 12-thread CPU profile, tick 70 was both the slowest wall tick and
  the one with the largest GC overlap. Previous/slow/next/same-burst
  reference ticks 69/70/71/80 took 118.36/143.00/112.74/138.54 ms.
  The 10.47 ms minor GC on tick 70 began just after the measured game
  logic ended and accounted for almost all of the 10.90 ms yield gap.
  Command execution took 26.07 ms versus 17.77 ms on tick 80, while
  movement took 60.12 versus 61.24 ms. Main-thread samples captured GC.
  Helper samples showed movement throughout, navigation and acquisition
  in the neighbors, and more status work on tick 70.
- The mixed replay matched all 65 hashes with 0 and 3 helpers. Boost,
  effective-stat kernel parity, structure table, shared-stat snapshot and
  order supersession checks passed.

## 2026-11-04: reuse retirement records and command storage

- Routine detachment stores the stale ID, owner and quantized position on
  the existing unit wrapper. The common stale reads use those values.
  General detached access can still materialize the writable compatibility
  record. Retirement's two native calls reuse fixed argument arrays.
- Move-order entries are reserved at load up to the existing 16,384-entry
  kernel bound and recycled after drain. Removal shifts entries without
  splice's temporary removed-item array. The existing overflow fallback
  can still create entries, and the JS order queue and map can grow.
- Research capacity scans the authoritative spawner list without building
  type buckets. Commands that only need lab existence use an early-exit
  scan. Match load seeds order-check entries and their research level keys
  for the configured catalogue. Reordering moves tasks in place and uses a
  reusable touched list. First-time unknown stat keys and new research tasks
  can still allocate.
- The initial allocation capture reduced the retirement subtree from
  7.94 to 2.34 MiB and total simulation allocation from 83.56 to 76.40
  MiB. This capture preceded in-place research reordering.
- The final allocation capture measured 72.88 MiB of simulation allocation,
  including 2.31 MiB in retirement and 11.54 MiB in command execution
  (previously 7.94 and 19.14 MiB). Capacity lookup and research order
  checking had no allocation samples, and lab existence checks sampled
  0.03 MiB. Synthetic input and harness totals were 183.11 and 83.24 MiB.
  Research queue fuzz, supersession, slot reuse and snapshot checks passed,
  including a check that common stale reads leave the record unallocated.
  The mixed replay matched all 65 hashes with 0 and 3 helpers.
- Serial unprofiled runs used WASM32, 11 helpers, dk1 and settled population
  285,916–376,010 over ticks 60–159. Work and hash `f8162538` matched.
  No settled tick exceeded 1.5× median or 500 ms.

  | Run | Wall mean | p95 | p99 / max | GC overlap / longest |
  | --- | ---: | ---: | ---: | ---: |
  | Previous reference A | 106.33 ms | 133.50 ms | 155.38 ms | 39.02 / 14.53 ms |
  | Candidate A | 101.17 ms | 129.17 ms | 145.88 ms | 25.61 / 9.37 ms |
  | Reference B | 100.54 ms | 122.24 ms | 131.51 ms | 37.18 / 14.31 ms |
  | Candidate B | 98.06 ms | 116.60 ms | 140.16 ms | 25.74 / 9.21 ms |

  GC overlap and longest pause fell in both comparisons. The wall max
  improved only in A. Reference A/B → candidate A/B rates per wall second
  were 673.4/712.2 → 707.8/730.3 spawns, 209.8/221.9 → 220.5/227.5
  research deposits, 89.2/94.3 → 93.7/96.7 collector deposits and
  80.2/84.8 → 84.3/87.0 astar deposits. Raw rows and reference sources
  are in `tests/test-runs/retire-command-gc-20261104/`.
- The 12-thread profile's largest GC overlap was tick 70. Previous/slow/
  next/normal same-burst ticks 69/70/71/80 took 126.4/145.8/123.5/134.8
  ms, with 10.3 ms of GC on tick 70 alone. Main samples showed GC and
  movement. Worker search and spatial indexing gained helper samples.
  The worst whole tick was the tick 60 burst at 153.0 ms with zero GC.
  Its previous/next/reference ticks 59/61/70 took 120.2/144.6/145.8 ms.

## 2026-11-04: reuse move IDs and read tower coordinates directly

- Immediate move and attack-move commands with array IDs use a fixed
  20,000-entry numeric buffer and carry a separate valid count through
  supersession and admission. The borrow is synchronous and released in
  a finally block. Nested dispatch falls back to an owned result if the
  buffer is busy. Public sanitization still returns an owned array.
- Immediate tower targeting validates its packet coordinates during
  application, without copying the array or allocating per-coordinate
  objects. Unit targets and clears write the existing numeric tower
  fields directly. Immediate commands with no IDs reuse an empty list.
- The move-only allocation capture sampled 0.38 MiB in the ID cleaner
  and its callees, down from 3.28 MiB. Total sampled simulation allocation
  was 91.47 MiB versus 91.91 MiB in the preceding version.
- With the tower and empty-list changes, sampled simulation allocation
  fell to 83.56 MiB, sanitization including callees to 0.85 MiB, and ID
  cleaning to 0.32 MiB. Synthetic inputs were 183.23 → 182.80 MiB and
  harness/other 84.70 → 83.63 MiB. Retirement still sampled 7.94 MiB
  and action execution 19.14 MiB including callees.
- Serial unprofiled runs used production WASM32, 11 helpers, dk1 and
  settled population 285,916–376,010. All matched hash `f8162538` and
  work counts. No settled tick exceeded 500 ms.

  | Run | Wall mean | p95 | p99 / max | >1.5× median | GC overlap / longest |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Previous reference A | 105.20 ms | 136.95 ms | 168.84 ms | 1 | 40.20 / 14.96 ms |
  | Candidate A | 102.72 ms | 131.72 ms | 156.68 ms | 1 | 32.50 / 14.77 ms |
  | Reference B, previous main.js | 100.57 ms | 127.76 ms | 144.05 ms | 0 | 39.04 / 14.89 ms |
  | Candidate B | 106.33 ms | 133.50 ms | 155.38 ms | 0 | 39.02 / 14.53 ms |

  Reference A/B → candidate A/B wall-second rates were 680.7/712.1 →
  697.1/673.4 spawns, 212.1/221.8 → 217.2/209.8 research deposits,
  90.1/94.3 → 92.3/89.2 collector deposits and 81.1/84.8 → 83.0/80.2
  astar deposits. Tail and total GC changes did not repeat.
- The final all-thread capture's largest GC overlap and worst whole tick
  were both at tick 60. Previous/slow/next/normal same-burst-reference
  ticks 59/60/61/70 took 123.2/164.3/146.7/135.1 ms. Tick 60 overlapped
  15.3 ms of GC and the other three had zero GC. Actions on the two burst
  ticks took 30.4/26.0 ms. Movement was 70.3/62.2/80.2/63.9 ms. Main samples
  show GC and movement. Helpers sampled more slot zeroing and visibility
  work on the slow tick than on the normal reference.
- Native ID cleaning, budget, supersession, order columns, tower cases
  and tower SIMD checks passed. Mixed replays matched all 65 hashes
  with 0 and 3 helpers. Raw runs and profiles are in
  `tests/test-runs/move-id-gc-20261104/`.
- The production sender regression decoded all 200,000 IDs in order from
  ten move actions. A separate mixed chaos mass-click run selected 235,326
  live units on tick 20 and had zero queued units and zero backlog IDs
  by tick 23. The 20,000-entry scratch capacity follows the existing
  per-action limit. The sender still splits larger selections.

## 2026-11-04: reserve slot-release and slab lists

- The deferred release queue has one entry per reserved unit slot. The
  slot-zero kernel reads it directly and the JavaScript consumer resets its
  count. State replacement and compaction release the old reservation.
  Detached units still keep their own stale-state record.
- The slab allocator stores its local-hole, global-hole and empty-slab
  stacks in a numeric arena sized at match reservation. Rebuilding the
  stacks resets the heads and cursor. The bound covers the initial relist
  plus up to two entries per release before the next relist. Push and pop
  order and stale-entry handling follow the prior implementation.
- Immediate sanitized commands use the cleaned ID list for unit resolution
  and queued-order cancellation. Direct sanitized actions still expose the
  lazy membership Set. The cleaned IDs and resolved-unit output still
  have per-command storage. Tower stats reuse the source table and resolve
  neutral stat entries once per tower type during each refresh.
- Sampled simulation allocation over 100 settled ticks was
  99.67 → 97.69 → 91.91 MiB for the previous version, initial candidate,
  and final candidate. Synthetic inputs were 182.99/182.61/183.23 MiB
  and harness/other 84.33/86.44/84.70 MiB. The slab relist went from
  1.84 MiB to no samples, the slot-release subtree from 2.10 to 0.22 MiB,
  and tower stat preparation from 2.57 to 1.88 MiB. Retirement
  (7.25 MiB including detached records) and command sanitization
  (6.73 MiB including cleaned IDs) remain significant. The release queue
  held 1,150,976 slots and the slab arena 376,070 words from tick zero
  through the final tick. End-of-match live WASM was 3,030 → 3,032 MiB.
- Serial production WASM32 runs used 11 helpers, dk1, and population
  285,916–376,010 over ticks 60–159. Work and hash `f8162538` matched.

  | Run | Wall mean | p95 | p99 / max | >1.5× median | GC overlap / longest |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Previous full reference | 104.48 ms | 129.81 ms | 155.47 ms | 0 | 50.97 / 14.01 ms |
  | Candidate before slab arena | 102.03 ms | 133.24 ms | 159.75 ms | 1 | 39.69 / 14.60 ms |
  | Reference with tower change | 101.67 ms | 131.81 ms | 140.96 ms | 0 | 46.68 / 13.35 ms |
  | Final candidate | 105.20 ms | 136.95 ms | 168.84 ms | 1 | 40.20 / 14.96 ms |

  None exceeded 500 ms. Reference and final rates per wall second were
  685.4/680.7 spawns, 213.5/212.1 research deposits, 90.7/90.1 collector
  deposits and 81.6/81.1 astar deposits. Total GC overlap fell, while
  longest pause and whole-tick max did not improve in these runs. A final
  empty-list guard skips cancellation lookup work for actions without IDs.
  The supersession test passed after that guard.
- The separate 12-thread CPU profile's largest GC overlap was also its
  worst whole tick. Previous/slow/next/normal same-burst reference ticks
  99/100/101/90 took 114.7/178.6/163.2/147.5 ms. Only tick 100 overlapped GC
  (17.7 ms). Movement was 64.8/68.5/98.7/67.6 ms. The slow tick's main
  samples show GC. Helpers show more visibility and effective-stat work.
  Tick 101 had longer movement without GC.
- Retirement, shared-unit growth and slot reuse, snapshots, action
  cleanup/budget/supersession, tower cases, tower SIMD determinism and the
  mixed 65-hash replay with 0 and 3 helpers passed. Raw captures and
  reference sources are in `tests/test-runs/zero-gc-20261104/`.

## 2026-11-04: reserve retirement scratch and reuse command, research and visual data

- Retirement planner and cleanup buffers now reserve against the match's
  unit slot capacity during loading. In the mixed chaos capture, all 160
  ticks recorded 1,150,976 slots, 1,150,976 planner records and 1,187,840
  cleanup entries. The reserved buffers added 13 MiB live WASM at the end
  of this match. Detached unit records still have independent lifetimes.
- Damage flash complements are prepared per owner at load and reused on
  the local simulation/render path. A palette change refreshes the affected
  entry. The simulation worker has its own visual event forwarding path.
  Research order checks retain the per-player map and refresh counters by
  rebase epoch. A stat's first encounter can still create an entry.
- Command sanitization shares property descriptors. Large immediate rally
  commands validate and pack into the existing order tile buffer without
  allocating a sanitized coordinate array. Invalid pairs, accepted-pair
  cap and input order were checked against the public sanitizer path.
- In allocation profiles before the rally change, sampled simulation
  allocation fell from 114.36 to 102.04 MiB. Full-stack damage visual
  allocation was 9.50 → 2.59 MiB, research order checks 2.35 → 1.59 MiB,
  command sanitization 13.04 → 10.43 MiB, and retirement 10.56 → 9.24 MiB.
  Synthetic inputs were 184.01/185.96 MiB and harness/other 82.17/81.88 MiB.
- With direct rally packing, simulation allocation sampled 99.67 MiB,
  including 7.11 MiB for sanitization with callees, 9.96 MiB for
  retirement, 3.03 MiB for damage visuals, and 1.13 MiB for research order
  checks. Synthetic input and harness allocation were 182.99 and 84.33
  MiB, respectively. Detached unit records, owned command results,
  membership sets and renderer bookkeeping still allocate. The browser
  simulation worker's event transport was outside this headless census.
- The last unprofiled reference and final candidate ran serially with
  production WASM32, 11 helpers, dk1, ticks 60–159, population
  285,916–376,010 and matching work and hash `f8162538`. Reference →
  final mean/p95/p99/max were 108.12/147.32/223.76/223.76 →
  104.48/129.81/155.47/155.47 ms. Slow ticks above 1.5× median were 3 → 0,
  with zero above 500 ms. GC overlap was 82.96 → 50.97 ms. The final run
  had four minor pauses, longest 14.01 ms. Wall-second rates were
  662.3 → 685.4 spawns, 206.3 → 213.5 research deposits, 87.7 → 90.7
  collector deposits, and 78.9 → 81.6 astar deposits. The earlier
  candidate before rally packing had a 224.00 ms max and 59.18 ms of
  GC overlap. This series does not establish a repeatable tail improvement
  for the final version.
- The 12-thread profile before the rally change had its largest GC overlap
  at tick 120. Previous/slow/next/normal ticks 119/120/121/130 took
  97.8/189.5/195.1/152.7 ms wall and 58.4/84.3/99.0/69.0 ms in movement.
  Tick 120 overlapped 16.7 ms of GC and tick 130 had the same burst status.
  Tick 121 was the overall max with zero GC. Its nearby normal non-burst
  reference tick 132 took 133.0 ms, with 64.0 ms of movement. Helpers
  sampled more navigation fields, target acquisition and atlas work.
- Research partial rebase and multiplayer queue fuzz, retirement, local
  visual snapshot, action cleanup, supersession, budget and mixed replay
  checks passed. Raw profiles, reference sources and timing rows are in
  `tests/test-runs/damage-gc-20261104/`.

## 2026-11-04: gameplay allocation census and reserved adjacency scratch

- Adjacency reserves per-player stat columns at match load from the player
  count and building stat key count. Research and boost changes refill
  those columns and reuse their descriptor. Structure status class arrays
  and adjacency column property names are constructed once. Larger
  configurations and restored heaps retain the existing capacity checks.
- Command ID cleanup sizes the native result list from the returned count.
  Supersession compacts its privately owned list in place. Selected-unit
  traversal uses Set.forEach on ordinary sets. The per-command result
  arrays and membership sets still allocate.
- Sampled simulation allocation over 100 settled ticks was
  **127.00 → 118.50 → 114.36 MiB** for reference, command changes, and
  command plus adjacency changes. Synthetic input generation sampled
  183.71/184.59/184.01 MiB and harness/other 82.43/81.94/82.17 MiB.
  The full-stack allocation totals for ID cleanup were 10.97 → 3.26 MiB.
  Selected-unit resolution was 1.04 → 0.51 MiB. The aggregate `next`
  entry includes many unrelated iterators. Adjacency class/column
  lookup sampled 4.16 MiB before and had no samples after. The per-player
  stat refresh still sampled 1.38 MiB including callees.
- Remaining sources include retirement (10.56 MiB including callees),
  damage visuals (9.50 MiB including callees), command sanitization
  (7.17 MiB self, plus cleaned IDs), and research order checks
  (2.35 MiB including callees). The detached retirement record currently
  owns stale coordinates and survives reuse of the original slot.
- The serial unprofiled pairs below compare the command changes alone
  against the previous implementation. All runs used WASM32, 11 helpers,
  dk1, and population 285,916–376,010 over ticks 60–159. Work counts and
  hash `f8162538` matched. No settled tick exceeded 500 ms.

  | Run | Wall mean | p95 | p99 / max | >1.5× median | GC overlap / major pause |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 102.53 ms | 135.03 ms | 157.21 ms | 2 | 57.62 / 26.91 ms |
  | Command A | 106.39 ms | 137.76 ms | 149.51 ms | 0 | 66.84 / 19.76 ms |
  | Command B | 103.05 ms | 136.79 ms | 164.73 ms | 1 | 64.01 / 19.90 ms |
  | Reference B | 103.61 ms | 132.87 ms | 151.58 ms | 0 | 72.53 / 26.38 ms |

  The major pause fell in both pairs. Total GC and tick maxima moved in
  opposite directions. Reference A/B → command A/B wall-second rates were
  698.4/691.1 → 673.1/694.9 spawns, 217.6/215.3 → 209.7/216.5 research
  deposits, 92.5/91.5 → 89.1/92.0 collector deposits, and 83.2/82.3 →
  80.2/82.8 astar deposits.
- The final command-plus-adjacency unprofiled run matched the population,
  work and hash. Wall mean/p95/p99/max were 103.63/133.95/195.14/195.14 ms
  with one tick above 1.5× median and none above 500 ms. Its worst tick,
  86, had zero overlapping GC. The window had 68.69 ms overlapping GC
  and an 18.99 ms major pause. Wall-second rates were 691.0 spawns,
  215.3 research deposits, 91.5 collector deposits and 82.3 astar deposits.
- The all-thread command-candidate profile's largest GC overlap was
  26.6 ms on tick 113. Previous/slow/next/normal non-burst ticks
  112/113/114/133 took 140.5/157.9/101.6/112.9 ms with movement at
  68.2/106.2/59.1/72.5 ms. The slow tick's main thread samples include
  GC, the movement barrier and footprint motion. The worst whole tick
  was 61 at 203.0 ms with 20.2 ms of GC. Its previous/next/normal
  non-burst reference ticks were 60/62/71 at 170.3/136.5/132.5 ms.
- Action ID, arrival, supersession and budget tests passed. Adjacency
  matched the JavaScript reference with 11,490 buildings. The final
  mixed replay matched all 65 hashes with 0 and 3 helpers. Raw rows,
  source snapshots and allocation and CPU profiles are in
  `tests/test-runs/gameplay-gc-20261104/`.

## 2026-11-04: extend the foreground barrier to wanted steps

- The simulation thread now also waits for `SIM_KERNEL_MOVE` (8) without
  claiming background jobs. The existing occupancy guard still covers the
  four passes that follow. The occupancy-only version was the reference.
- Two serial pairs in opposite orders used production WASM32, 11 helpers,
  dk1 and settled mixed chaos ticks 60–159. Population was 285,916–376,010
  with 7,161 births and 97,801 deaths. All four runs matched hash
  `f8162538` and the work counts.

  | Run | Wall mean | Wall p95 | Wall p99 / max | >1.5× median | Wanted-step mean / p95 / max |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 104.72 ms | 137.16 ms | 152.86 ms | 0 | 21.79 / 27.04 / 41.56 ms |
  | Candidate A | 103.38 ms | 130.25 ms | 144.52 ms | 0 | 21.13 / 24.56 / 25.62 ms |
  | Candidate B | 98.23 ms | 124.08 ms | 135.50 ms | 0 | 20.09 / 22.91 / 25.31 ms |
  | Reference B | 99.11 ms | 127.49 ms | 160.89 ms | 1 | 20.31 / 23.17 / 38.10 ms |

  No settled tick exceeded 500 ms. GC overlap in that order was
  59.43/57.62/58.86/60.18 ms. Reference A/B → candidate A/B wall-second
  rates were 683.8/722.6 → 692.7/729.0 spawns, 213.0/225.1 → 215.8/227.1
  research deposits, 90.5/95.7 → 91.7/96.5 collector deposits and
  81.5/86.1 → 82.5/86.8 astar deposits. The next-index wait mean fell
  from 4.10/3.94 to 3.71/3.62 ms. The tick lane wait mean was
  1.70/1.61 → 1.67/1.60 ms. Neither wait showed a repeatable regression.
- The separate named 12-thread capture compared previous/slow/next/normal
  non-burst ticks 155/156/157/145. Wall was 85.5/140.3/137.3/104.4 ms
  and kernel 8 was 21.1/32.2/26.6/21.9 ms, with zero GC and zero
  simulation-thread `_simBgHelp` samples inside kernel 8. On the slow
  tick, main samples concentrated in wall segment checks and flow lookups.
  Across threads, atlas exit selection, combat and wall segment checks
  gained the most self samples versus the reference. These are concurrent
  samples. Tick 117, the previous capture's worst kernel 8 tick, took
  21.3 ms in this capture. The worst whole tick was the tick 60 command
  burst, with 37.3 ms command processing and 27.0 ms in kernel 8.
- The mixed replay matched all 65 hashes with 0 and 3 helpers. The grid
  audit passed with 0 and 7 helpers. Raw ticks, profiles, slices and the
  reference source are in `tests/test-runs/move-barrier-20261104/`.

## 2026-11-04: keep background jobs off the occupancy barrier

- The simulation thread waits for the last foreground occupancy chunks
  without claiming a background chunk. It remains available to post the
  next pass. Helpers still take background work under their existing policy.
- Six serial, unprofiled mixed chaos runs used production WASM32, 11 helpers,
  dk1 and settled ticks 60–159. The actual population was 285,916–376,010
  with 7,161 births and 97,801 deaths in that window. All runs matched hash
  `f8162538` and the work counts. No settled tick exceeded 500 ms.

  | Run | Wall mean | Wall p95 | Wall p99 / max | >1.5× median | Occupancy mean / p95 / max |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 104.91 ms | 138.04 ms | 161.55 ms | 1 | 31.41 / 42.40 / 53.94 ms |
  | Scheduling A | 105.12 ms | 135.48 ms | 158.46 ms | 1 | 30.60 / 38.49 / 39.71 ms |
  | Scheduling + Rust A | 106.39 ms | 133.13 ms | 137.24 ms | 0 | 31.56 / 41.24 / 48.49 ms |
  | Scheduling + Rust B | 102.64 ms | 126.51 ms | 141.64 ms | 0 | 30.15 / 37.13 / 48.53 ms |
  | Reference B | 109.82 ms | 174.83 ms | 328.82 ms | 7 | 32.67 / 46.53 / 96.98 ms |
  | Scheduling B | 102.18 ms | 127.80 ms | 163.56 ms | 1 | 30.01 / 37.39 / 38.70 ms |

  Total GC overlap in that order was 59.00, 61.83, 63.11, 44.90, 67.44
  and 58.26 ms. Reference A/B → scheduling A/B wall-second rates were
  682.6/652.1 → 681.2/700.9 spawns, 212.6/203.2 → 212.2/218.3 research
  deposits, 90.4/86.3 → 90.2/92.8 collector deposits and 81.3/77.7 →
  81.1/83.5 astar deposits. The raw rows retain the larger early gameplay
  spikes. Reference B's slowest tick had only 9.66 ms of GC and expanded
  across several phases. There is no CPU capture for that run to identify
  the cause. The scheduling runs' worst ticks were both tick 113 with about
  25.5 ms of GC overlap and occupancy at 33.0/30.6 ms.
- The 12-thread named profile used the same diagnostic WASM as the previous
  capture. Previous/slow/next/normal non-burst ticks 64/65/66/68 took
  117.1/126.7/116.8/104.7 ms wall and 38.3/45.1/37.7/31.2 ms in occupancy,
  with zero GC. The simulation thread had no `_simBgHelp` samples inside
  occupancy on any of these ticks. Across all threads, non-idle samples
  outside the occupancy stack grew from 14.9 to 149.7 ms on tick 65.
  Helpers were doing target answers and navigation fields, while the main
  thread was mostly in movement. These concurrent samples show overlap
  and do not isolate its cost. The worst whole tick was the tick 60 action
  burst. Against burst tick 70, command processing was 31.6 vs 28.8 ms,
  kernel 8 was 28.5 vs 24.8 ms, and occupancy was 34.2 vs 33.2 ms.
- A separate slice of the same capture shows the next barrier candidate.
  The wanted-step kernel (8) averaged 23.1 ms and took 20.0/41.6/19.8/19.2
  ms on previous/slow/next/normal non-burst ticks 116/117/118/119, all
  without GC. The simulation thread sampled 19.8 ms in `k_acq_area_build`
  via `_simBgHelp` during the slow kernel and zero on the other three.
  Helpers also ran atlas and navigation work. Occupancy counts (97) on
  tick 117 sampled 2.57 ms in `acq_omt` at its barrier and averaged 0.81 ms
  over the window. Traffic capture (93) averaged 0.74 ms. The traffic
  lane's result wait averaged 0.009 ms. These slices use the existing
  scheduling-only capture and do not measure a change to those barriers.
- The Rust trial bypassed duplicate short-step raster probes in axis slides
  and pruned swap candidates unable to reach the existing three-entry
  shortlist. It improved whole-tick max in these runs, but the targeted
  occupancy max was about 48.5 ms in both runs and the average occupancy
  improvement did not repeat. The production Rust sources and WASM remain
  at the reference version. Footprint and swap work remains the recurring
  occupancy bottleneck. Raw ticks, source and binary snapshots are in
  `tests/test-runs/occupancy-opt-20261104/`.
- The occupancy grid audit passed with 0 and 7 helpers across the tested
  collision planes. The mixed replay matched all 65 hashes with 0 and 3
  helpers.

## 2026-11-04: occupancy phase and stack attribution

- The slicer now combines phase prefixes and can separate a kernel's stack
  from other work during the same phase. A fresh named WASM32 diagnostic
  captured all twelve threads with 1 ms sampling. Diagnostic-only counters
  record nonzero steps, pressure samples, primary/alternate footprint probes,
  shoulder attempts and swaps per spatial block. Production WASM and Rust
  movement files are unchanged. The run matched hash `f8162538` and the
  existing settled work counts, with population 285,916–376,010. This is a
  profile run, not an unprofiled speed comparison. Mean/p95/p99/max wall
  was 113.06/149.06/156.11/156.11 ms, with zero settled ticks above 500 ms
  or 1.5× median. Measured rates per wall second were 633.4 spawns, 197.3
  research deposits, 83.8 collector deposits, 75.4 astar deposits.
- Occupancy's own named hotspot is `checked_traffic_q`, which steers from
  traffic pressure, tests the wall segment and swept footprint, tries up to
  four shoulders if clipped, then commits the chosen footprint. The normal
  tick 143 performed 219,570 nonzero checks, 64,898 shoulder entries and
  145,531 alternate probes. It tried 25,036 swaps and completed 389. These
  probes are additional to 219,564 primary footprint probes. In all four
  occupancy passes, normal traffic-check self samples summed to 63.7 ms
  across threads versus 26.8 ms for leader direction, 26.6 ms for yielding,
  18.6 ms for footprint motion and 14.1 ms for swaps. These are concurrent
  samples, with inlined work attributed to callers.
- Previous/slow/next/normal non-burst reference ticks 144/145/146/143 had
  wall 135.5/149.1/105.3/97.8 ms and occupancy 46.8/64.3/33.2/31.2 ms, all
  with zero GC. Pass 0 grew from 7.3 ms on tick 143 to 31.8 ms on tick 145.
  Tick 145 checked 218,956 nonzero steps, had 65,617 shoulder entries and
  146,700 alternate probes, close to the normal tick. Its heaviest block
  had 939 alternate probes versus 911. Swap attempts were 25,247 versus
  25,036. There is no corresponding jump in counted work.
- During pass 0, occupancy-stack samples summed to 94.9 ms on the spike
  and 84.5 ms on the reference. Non-idle samples outside that stack grew
  from 3.1 to 193.6 ms across threads. The simulation thread alone sampled
  22.9 ms in `k_acq_area_build` via `_simBgHelp` inside `simParallelRun`.
  Helpers ran atlas route and table building and navigation fields. The
  caller cannot return from the acquisition chunk when the occupancy jobs
  finish. That identifies a foreground scheduling issue separate from the
  recurring occupancy work. Samples do not measure cache misses or establish
  how much the pass would save with different scheduling.
- Saved older profiles show both patterns. Occupancy rose 33.35 → 82.05 ms
  at tick 85, with checked-traffic and footprint motion samples growing.
  At tick 109 it rose 29.70 → 67.26 ms with nearly identical attempt counts,
  footprint motion samples flat and much more overlapping background work.
  Raw rows, stacks, slices and diagnostic source are in
  `tests/test-runs/occupancy-20261104/` and the earlier `movement-20261104/`.

## 2026-11-04: packed worker replies and SIMD validation trial

- Helpers packed reply headers into contiguous slot, ID, kind, and stamp
  columns in commit order, with contiguous candidate rows after them.
  Foreground SIMD compared four request headers at a time. It still gathered
  current death, ID and kind by unit slot and the stamp by worker record.
  Live reservations and writes stayed in the scalar ordered loop.
- Two serial opposite-order pairs used production WASM32, 11 helpers, dk1,
  160 ticks and settled ticks 60–159. Mixed replay with 0/3 helpers passed.
  All four large runs matched hash `f8162538`, work and population
  285,916–376,010. No settled tick exceeded 500 ms. Early maxima remain
  1.79–1.97 s in the raw rows.

  | Run | Mean tick | p95 | p99 / max | >1.5× median | Mean / max take |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 106.01 ms | 141.84 ms | 218.51 ms | 2 | 3.18 / 6.07 ms |
  | Candidate A | 104.43 ms | 135.74 ms | 146.29 ms | 0 | 3.14 / 4.86 ms |
  | Reference B | 105.18 ms | 137.11 ms | 157.99 ms | 1 | 3.05 / 5.13 ms |
  | Candidate B | 106.06 ms | 133.01 ms | 158.96 ms | 1 | 3.18 / 5.16 ms |

  GC overlap was 60.76/60.95 → 58.76/64.85 ms. Reference A/B → candidate
  A/B wall-second rates were spawns 675.5/680.8 → 685.7/675.2, research
  deposits 210.4/212.1 → 213.6/210.3, collector deposits 89.4/90.1 →
  90.8/89.4, astar deposits 80.5/81.1 → 81.7/80.4.
- The all-thread capture retained previous/slow/next/reference ticks
  112/113/114/97, wall 145.45/150.67/93.05/103.45 ms. The slow tick had
  28.46 ms overlapping GC and no result commit. Main samples show GC and
  dispatch, with navigation and acquisition work on helpers. The preceding
  tick had a 5.57 ms take, 71.21 ms movement, and zero GC.
- The direct commit improvement did not repeat. Production source and
  WASM32 were restored to the background-proposal implementation. The
  candidate, baseline, reproduction runner, raw traces and summaries are
  in `tests/test-runs/commit-simd-20261104/`. A separate live request token
  or invalidation table would address the validation gathers. Packing only
  the posted values cannot represent live changes between post and commit.

## 2026-11-04: background return-spawner proposals and direct result commit

- Search posts snapshot only eligible builder and healer spawners in compact
  owner/role buckets. The existing search chain now emits return destinations
  from posted worker positions after ordering the replies. The commit reads
  those proposals, validates each tile live, and applies the ordered results
  in one native pass. An invalid proposal takes the existing no-spawner path.
  It does not trigger a replacement search during the commit.
- `waiTake` no longer launches and joins worker-brain preparation or a
  parallel decision/apply round. It also reads the search order in place.
  An intermediate direct-lookup trial cut search-phase mean from 5.87/5.95
  to 3.45/3.71 ms but still searched a sparse spawner bucket on the foreground.
  The retained version moves that lookup into the posted chain. Its fixed
  deadline scan join remains. The unprofiled candidate's measured lane-4
  wait max was 0.09/0.02 ms. This remains a possible wait if the scan is late.
- Serial opposite-order WASM32 comparisons ran with 11 helpers, dk1, 160
  ticks and settled ticks 60–159 of the large mixed scene.

  | Run | Mean wall | p95 | p99 / max | >1.5× median | Search phase mean / max |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 102.19 ms | 132.85 ms | 172.23 ms | 1 | 5.70 / 26.08 ms |
  | Candidate A | 96.72 ms | 124.58 ms | 139.82 ms | 0 | 2.31 / 6.57 ms |
  | Reference B | 110.86 ms | 148.28 ms | 161.83 ms | 0 | 5.97 / 22.20 ms |
  | Candidate B | 102.84 ms | 134.38 ms | 139.67 ms | 0 | 2.55 / 8.55 ms |

  All had zero settled steps above 500 ms. Early maxima were 1.74–1.84 s.
  GC overlap was 47.45/48.23 → 59.52/55.12 ms over the settled window.
- Candidate A's 6.57 ms search max was post tick 146, with zero GC.
  Request selection/packing took 2.11 ms, collector group rebuilding
  0.77 ms, and the search join 0.008 ms. The remaining post/grid work was
  not fully subphased in this run. Candidate B's 8.55 ms search max was also
  a post, tick 66, with 1.84 ms selection, 2.12 ms group rebuilding and
  0.009 ms search join. The guarded diagnostic measured 25 settled takes at
  3.29 ms mean and 6.38 ms max. Snapshot preparation averaged 0.54 ms with a
  0.88 ms max. A guard rejected any helper join, parallel dispatch or
  separate search call inside `waiTake` across 39 takes and 294,851 replies.
- A focused non-CPU-profile diagnostic (`commit-breakdown.json`) measured
  eight settled takes averaging 3.27 ms. The native commit call accounted
  for 2.83 ms, with JavaScript setup and teardown accounting for about
  0.44 ms and event output under 0.01 ms. The 6.38 ms profiled take had
  6,466 replies and no GC. The same tick and reply count took 3.32 ms in
  the focused run, including 2.79 ms in the native call. The 6.38 ms peak
  is not a repeatable cost for that batch. Native candidate validation,
  reservations and approach selection were not timed individually.
- Population was 285,529–375,694 in the reference and 285,916–376,010 in
  the candidate. Exact hashes match within each implementation (`338091ed`
  reference, `f8162538` candidate). Posted spawner eligibility and ordered
  direct assignment change the work mix. Counts include 7,541 → 7,161
  spawns and 1,996 → 2,231 research deposits. Reference A/B → candidate A/B
  rates per measured wall second were spawns 737.9/680.3 → 740.4/696.3,
  research deposits 195.3/180.1 → 230.7/216.9, collector deposits 87.2/80.4 →
  98.0/92.2, and astar deposits 81.1/74.8 → 88.2/82.9.
- The twelve-thread profile retains previous/slow/next/reference ticks
  75/76/77/84. Wall was 141.82/193.71/154.58/117.15 ms, all with zero
  overlapping GC. Slow/reference movement was 98.97/66.26 ms and worker
  search 7.93/4.92 ms. Next-tick movement was 109.01 ms. Main samples include
  parallel dispatch and movement functions, helpers include native movement
  kernels. The reference shares action-burst status.
- WASM32 `38a283105079d750` and WASM64 `97e415cd04186fc1` were rebuilt.
  Mixed replay checks with 0/3 helpers passed on both builds.
  Raw profiles, tick rows, source overrides, guard, measurements and the
  intermediate direct-lookup comparison are retained in
  `tests/test-runs/commit-nowait-20261104/`.

## 2026-11-04: four worker-search cohorts

- The large mixed fixture uses 11 simulation helpers plus the simulation
  thread. In-game workers are separate. The first completed tick had 233,907
  live workers across six professions. Sampled ticks 60–159 had 118,193–178,896
  workers, with 25,413–32,754 holding targets. Targets indicate assignments,
  not successful transfers. The baseline had 87,501–141,273 registered
  searchers, including parked workers waiting for retries. The 25 actual
  baseline posts held 12,830–21,410 requests each, averaging 17,106.
- The benchmark-only dk1 trial partitions stable unit IDs into four groups
  and posts one group per tick. Two separate lanes and payload banks allow
  a fixed two-tick lead. Each bank has its own collector preparation and
  copies the work-site grid at post. The candidate diagnostic counted
  2,947–6,074 actual requests per tick, averaging 4,256. The 50-tick smoke
  replay with 0 and 3 helpers ended at `a6885b45` in both runs.
- Serial opposite-order trials used the 1,000,004-unit initial scene and
  100 settled ticks. Both candidates ended at `6a3301c2`, both references
  at `338091ed`. Changed reservation order changes work counts. Measured
  population was 285,529–375,694 in the reference and 285,929–375,944 in the
  candidate. Raw rows retain births, deaths, actual deposits and work rates.

  | Run | Mean wall | p95 | p99 / max | >1.5× median | GC overlap |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 114.55 ms | 146.12 ms | 168.07 ms | 0 | 53.50 ms |
  | Candidate A | 120.13 ms | 157.51 ms | 181.10 ms | 2 | 41.83 ms |
  | Reference B | 114.11 ms | 157.69 ms | 193.45 ms | 2 | 46.93 ms |
  | Candidate B | 116.07 ms | 144.69 ms | 202.79 ms | 1 | 41.99 ms |

  Zero steps above 500 ms in the settled window. Early maxima were 1.80–1.96 s.
  Reference A/B → candidate A/B throughput per measured wall second was
  spawns 658.3/660.9 → 604.5/625.6, research deposits 174.2/174.9 → 185.8/192.3,
  collector deposits 77.8/78.1 → 77.8/80.6, astar deposits 72.4/72.7 → 70.2/72.6.
- The search phase's max fell 24.34/23.01 → 20.22/17.43 ms, but its mean
  rose 6.08/6.04 → 13.08/12.22 ms. Crucial correction to the earlier wait
  interpretation: the posted scan's actual lane-4 wait max was 0.03/0.02 ms
  in the reference and 0.09/0.22 ms in the candidate. The new lane 13 max was
  0.03 ms. The large wait was on **lane 0**, where `waiTake` invokes
  `workerBrainsPrepare` without deferral. This posts the spawner site and
  nearest-spawner preparation and immediately collects it. Lane-0 totals
  include other tick work. Their p95 fell 21.98/21.07 → 15.07/11.28 ms, while
  their mean rose 5.82/5.86 → 7.77/7.07 ms. Splitting the scan posts does not
  remove commit-side preparation and now invokes it more often.
- The twelve-thread profile retains ticks 136/137/138/134, wall
  132.21/184.00/108.20/97.85 ms. The slow tick overlapped 27.33 ms GC and
  spent 99.54 ms in movement versus 59.23 ms on the same-burst reference.
  Search spent 11.46/11.71 ms. Main samples include GC and acquisition work,
  while helpers include movement, navigation fields and acquisition.
- The prototype was kept out of production. Source overrides, the WASM32
  build, raw counts, timings and profiles are in
  `tests/test-runs/search-cohorts-20261104/`. The measured foreground wait
  target is now commit-side spawner preparation rather than the scan deadline.

## 2026-11-04: movement profiles and helper partition trial

- Two named WASM32 captures profiled the simulation thread and 11 helpers.
  In the first, previous/slow/next/reference ticks 111/112/113/114 spent
  61/83/87/56 ms in movement. Tick 112 took 212 ms overall. Its 25.88 ms
  major GC event fell entirely inside the 29.49 ms hit-resolution phase.
  In the second capture, tick 112 resolved hits in 2.46 ms without GC.
- The first capture's movement-only spike at tick 85 took 142 ms versus
  60 ms on normal non-burst tick 84 and 97 ms on tick 86. There was no GC.
  Atlas route-step self samples summed across 12 threads were 122 ms on
  tick 85 versus 22 ms on tick 84 and 40 ms on tick 86. Including callees,
  the slow/reference figures were 151/41 ms. These are concurrent samples.
  The worst overall tick 112 had atlas step self samples of 32/15 ms versus
  tick 114. Traffic and occupancy work also appears in the slices.
- The second capture's max, tick 109, took 190 ms with zero GC. Its movement
  rose to 125 ms versus 54 ms on non-burst tick 107, with 227,399/227,870
  occupancy attempts, 81,475/81,131 blocked or clipped moves, and
  155,372/156,376 footprint updates. Neighboring ticks 108/110 spent 58/59 ms
  in movement. Atlas step samples fell on the slow tick. Helpers also ran
  atlas rebuild, navigation fields and acquisition work during movement.
  Elapsed timings and samples leave CPU scheduling versus cache and memory
  pressure unresolved. No hardware counters were collected.
- An atlas coordinate-arithmetic trial reduced main movement kernel p95
  30.59/26.50 → 24.35/24.04 ms in opposite-order pairs. Whole movement p95
  barely moved, 77.88/76.52 → 76.35/76.70 ms. Whole tick p95/max were
  145.54/172.75 → 134.56/149.46 ms and 142.76/150.96 → 142.72/152.32 ms.
  The production source and binary were restored. The diagnostic binary,
  raw timing series and all-thread captures remain in the run directory.
- A scheduler trial split the same 11 helpers into eight for foreground and
  tick-critical lanes, three for bulk and slower tier jobs. The simulation
  thread did not pick up background chunks while waiting for foreground.
  No role split was applied to production. The one-helper navigation cap
  was a separate single-pair diagnostic.

  | Run | Mean tick | Tick p95 | Tick p99 / max | Movement p95 / max | >1.5× median |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Shared A | 109.80 ms | 151.82 ms | 230.32 ms | 82.27 / 106.99 ms | 3 |
  | Split A | 116.59 ms | 148.83 ms | 176.73 ms | 77.4 / 81.5 ms | 1 |
  | Shared B | 107.13 ms | 141.39 ms | 164.30 ms | 77.2 / 89.5 ms | 1 |
  | Split B | 121.53 ms | 157.56 ms | 171.6 ms | 81.9 / 97.2 ms | 0 |

  Neither pair had steps above 500 ms. The split's first-pair tail gain did
  not repeat. Split A's max was tick 112. Movement took 70.25 ms, search
  23.51 ms (including 21.6 ms waiting), and hits 24.27 ms with 20.22 ms
  overlapping GC. The next tick had longer movement at 74.3 ms and a total
  of 112.0 ms. The one-helper navigation cap had 110.1 ms mean, 142.7 ms
  p95 and 191.0 ms max against Shared A.
- All unprofiled trials use the large mixed fixture, dk1, 160 ticks and
  settled ticks 60–159. Hash `338091ed`, work, and settled population
  285,529–375,694 match. In the split comparison, reference A/B → candidate
  A/B wall-second rates were spawns 686.8/703.9 → 646.8/620.5, research
  deposits 181.8/186.3 → 171.2/164.2, collector deposits 81.1/83.2 →
  76.4/73.3, astar deposits 75.5/77.4 → 71.1/68.2. Raw captures, trial
  scheduler sources and diagnostic builds are in `tests/test-runs/movement-20261104/`.
- Worker search currently posts a batch two base ticks before the commit.
  `waiTake` assigns results and reservations at that fixed commit. Delaying
  when a local helper misses its deadline would make state depend on peer
  speed. A fixed longer deadline or fixed per-tick work budget is possible
  if search inputs are kept stable until the new commit.

## 2026-11-04: reduce retirement allocation and copying

- The cleanup kernel reads the retire planner's slot array directly, removing
  the copied buffer and temporary typed-array view. Detached records keep
  integer coordinates and convert on read, preserving exact stale positions
  and subsequent writes. Each retired unit still has its own detached record.
- Sampled retirement allocations including callees fell **12.02 → 10.62 MiB**
  (11.6%). Simulation total was **130.99 → 129.70 MiB**. Synthetic inputs
  were 181.47/182.19 MiB and harness/other 81.51/81.21 MiB.
- Serial opposite-order comparisons used WASM32, 11 helpers, dk1, 160 ticks
  and 100 settled mixed-chaos ticks. All had zero steps above 500 ms.

  | Run | Mean wall | p95 | p99 / max | >1.5× median | GC total / longest |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 113.65 ms | 149.74 ms | 194.19 ms | 2 | 65.83 / 17.16 ms |
  | Candidate A | 105.92 ms | 135.97 ms | 148.20 ms | 0 | 61.51 / 19.76 ms |
  | Reference B | 110.15 ms | 141.83 ms | 173.08 ms | 1 | 64.49 / 17.07 ms |
  | Candidate B | 106.89 ms | 141.41 ms | 175.02 ms | 1 | 53.50 / 22.01 ms |

  All had one major and one incremental event. Candidate B had three minor
  events and the other runs four. Early maxima were 1.82–1.89 s.
- The settled population was 285,529–375,694, with 7,541 births and 98,325
  deaths. Work and hash `338091ed` matched. Rates per measured wall second,
  reference A/B → candidate A/B, were spawns 663.5/684.6 → 712.0/705.5,
  research deposits 175.6/181.2 → 188.4/186.7, collector deposits 78.4/80.9 →
  84.1/83.4, astar deposits 72.9/75.3 → 78.3/77.6.
- Twelve-thread slices retain ticks 69/70/71/80 (previous/slow/next/normal
  same-burst reference), wall 127.47/204.65/119.90/146.47 ms. Slow/reference
  GC overlap was 16.42/0 ms. Movement was 94.20/58.33 ms, including the main
  kernel at about 34/22 ms and four occupancy passes totaling 53/33 ms.
  Main samples include GC and WASM execution. Helpers show native movement,
  background work and tower preparation. Phase elapsed times leave work
  volume versus helper scheduling unresolved.
- Candidate B's unprofiled max, tick 112, had 65.20 ms movement, 23.76 ms
  worker search (including 21.18 ms wait) and 22.01 ms overlapping GC.
  Neighboring ticks 111/113 and normal non-burst tick 114 had movement of
  53.89/81.95/48.95 ms. The next tick's main movement kernel alone rose to
  41 ms. Reference A's max tick 109 had zero GC and 115.75 ms movement, with
  52.85 ms in the main kernel and 22.32 ms in occupancy pass 3 alone.
- Retirement checks passed on WASM32 and WASM64, including fractional stale
  positions, writes, selection and slot mapping. Shared unit-state checks
  passed slot reuse and snapshot restoration. Mixed replays passed with 0/3
  helpers. Raw rows, baselines, summaries and profiles are in
  `tests/test-runs/retire-gc-20261104/`.

## 2026-11-04: reuse research rebase storage

- Research rebasing now retains per-player ordered scratch and per-stat
  numeric level/progress arrays, preserving equal-level ordering with stable
  insertion. It refills the existing queue before trimming and clears scratch
  task references after use. Scratch lifetime follows the player through a
  WeakMap. Storage still grows to observed queue/stat high-water marks during
  gameplay. Full loading-time reservation remains unfinished. Stat-key strings
  and the stale-order check still allocate. Descending same-stat queues have
  quadratic insertion work, so unusually large imported queues remain a
  performance case to investigate.
- Sampled rebase allocation including callees fell **9.56 → 4.20 MiB (56%)**.
  Total simulation allocation fell **136.91 → 132.28 MiB (3.4%)** over the
  100 settled mixed-chaos ticks. Synthetic inputs were 183.72/185.23 MiB and
  harness/other 81.13/80.91 MiB. The baseline allocation run's setup overlapped
  the end of correctness checks. All unprofiled timing runs were serial with
  no concurrent correctness runners or builds.
- Opposite-order production WASM32 pairs used 11 helpers, dk1, 160 ticks and
  measured ticks 60–159 in the same large mixed fixture.

  | Run | Mean wall | p95 | p99 / max | >1.5× median | Continuous GC |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 109.14 ms | 169.12 ms | 248.26 ms | 9 | 69.47 ms |
  | Candidate A | 107.13 ms | 137.39 ms | 163.59 ms | 1 | 69.32 ms |
  | Reference B | 106.88 ms | 142.02 ms | 155.17 ms | 0 | 64.65 ms |
  | Candidate B | 107.30 ms | 142.68 ms | 173.50 ms | 1 | 63.80 ms |

  All have zero steps above 500 ms and four minor, one major and one
  incremental GC event. Tail improvement remains inconsistent. Major pauses
  were reference A/B 24.38/19.28 ms and candidate A/B 18.73/18.09 ms.
  Early gameplay maxima of 1.79–1.88 s remain in the raw series.
- Population is 285,529–375,694, with 7,541 births and 98,325 deaths. Work
  counts and hash `338091ed` match. Reference A/B → candidate A/B measured
  wall-second rates are spawns 690.9/705.6 → 703.9/702.8, research deposits
  182.9/186.8 → 186.3/186.0, collector deposits 81.6/83.4 → 83.2/83.0,
  astar deposits 76.0/77.6 → 77.4/77.3.
- All twelve threads retain previous/slow/next/reference ticks 59/60/61/70,
  wall 115.65/172.09/141.37/125.49 ms. Slow/reference GC is 15.21/0 ms,
  actions 30.80/25.01 ms, worker search 15.80/5.06 ms and movement
  56.73/56.84 ms. Next-tick movement expands to 72.01 ms. Main samples show
  GC and background waiting, while helpers include visibility and slot reset.
- Validation passes 600 queue operations with partial/full rebase checks,
  the three-player research queue fuzz suite, mixed replays with 0/3 helpers,
  and 300 direct comparisons to the saved implementation covering full and
  partial rebases, equal/descending levels, capped progress and cleared scratch
  references. Raw profiles, baseline, equivalence check and timing summaries
  are in `tests/test-runs/research-gc-20261104/`.

## 2026-11-04: remove shared-stat publication temporaries

- Effective stat publication reuses each row's metadata as its unit context
  and writes the hot numeric buffer directly, removing a temporary object
  and eleven-element array per publication. No WASM binary changes.
- Sampled `_effRowWrite` allocation fell **1.22 → 0.09 MiB**, but total
  simulation allocation was **139.46 → 141.55 MiB**. This pass establishes
  a local reduction only. Synthetic inputs were 183.07/183.61 MiB and
  harness/other 80.16/82.71 MiB. Clone cache maps and boxed numeric accesses
  remain allocation sources in publication.
- Serial opposite-order comparisons used the large mixed workload, 11
  helpers, dk1, 160 ticks and measured ticks 60–159.

  | Run | Mean wall | p95 | p99 / max | Continuous GC |
  | --- | ---: | ---: | ---: | ---: |
  | Reference A | 106.70 ms | 144.60 ms | 158.48 ms | 63.64 ms |
  | Candidate A | 100.93 ms | 133.02 ms | 143.94 ms | 63.21 ms |
  | Reference B | 100.52 ms | 131.34 ms | 148.72 ms | 61.73 ms |
  | Candidate B | 100.86 ms | 134.36 ms | 151.23 ms | 63.30 ms |

  All four have zero steps above 500 ms or 1.5× median. Each has four minor,
  one major and one incremental GC event. Tail/GC improvement is inconclusive.
  Early gameplay maxima remain 1.73–1.98 s in the retained raw series.
- Measured populations remain 285,529–375,694, with 7,541 births, 98,325
  deaths and matching work counts and hash `338091ed`. Reference A/B →
  candidate A/B rates per wall second are spawns 706.8/750.2 → 747.1/747.6,
  research deposits 187.1/198.6 → 197.8/197.9, collector deposits 83.5/88.6 →
  88.3/88.3, astar deposits 77.7/82.5 → 82.1/82.2.
- All-thread slices retain previous/slow/next/reference ticks 59/60/61/70,
  wall 111.43/177.87/157.71/128.06 ms. Only the slow tick overlaps GC
  (16.31 ms). Its movement costs 59.37 ms and the next tick expands to
  92.25 ms. Main samples show GC, native spawner work and action arrival.
  Helpers include visibility seeding and slot reset work. The reference
  matches the action-burst status.
- Shared-row publication, owner/all/thing snapshot restoration, and mixed
  replays with 0/3 helpers pass. Raw rows, profiles, source baseline and
  summaries are in `tests/test-runs/eff-gc-20261104/`. Unit retirement,
  action sanitization and research queue rebasing remain larger targets.

## 2026-11-04: reuse spawner lookup buckets

- `_getWorkerSpawnersByType` now retains its map and per-type arrays across
  structure changes, overwrites members before trimming, and uses indexed
  traversal. Refills invalidate the downstream spatial bucket cache, whose
  identity/length check would otherwise retain same-size replacements.
  Snapshot resets still discard the index and its entity references.
- Sampled simulation allocation in the large mixed workload fell
  **151.33 → 139.51 MiB (7.8%)** over ticks 60–159. Direct spawner lookup
  allocation fell **5.78 → 2.09 MiB**. Synthetic inputs were 181.95/183.91
  MiB and harness/other 85.81/82.36 MiB. Bucket size changes still allocate.
- Serial production WASM32 comparisons used 11 helpers, dk1, 160 ticks,
  reversed pair order, and the same million-unit initial mixed fixture.

  | Run | Mean wall | p95 | p99 / max | >1.5× median | Continuous GC |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 110.35 ms | 145.27 ms | 168.07 ms | 1 | 60.13 ms |
  | Candidate A | 106.69 ms | 137.72 ms | 162.83 ms | 1 | 61.97 ms |
  | Reference B | 106.29 ms | 141.73 ms | 208.87 ms | 1 | 55.07 ms |
  | Candidate B | 106.58 ms | 139.89 ms | 148.01 ms | 0 | 66.45 ms |

  All have zero steps over 500 ms. References have five minor collections.
  Candidates have four minor, one major and one incremental collection,
  with major pauses of 18.89/19.28 ms. Lower sampled allocations and tails
  in these pairs have not eliminated gameplay GC.
- Measured population is 285,529–375,694 with 7,541 births and 98,325 deaths.
  Work counts and exact hash `338091ed` match across all four runs. Rates
  per measured wall second, reference A/B → candidate A/B, are spawns
  683.4/709.5 → 706.8/707.5, research deposits 180.9/187.8 → 187.1/187.3,
  collector deposits 80.7/83.8 → 83.5/83.6, astar deposits 75.1/78.0 → 77.7/77.8.
- Twelve-thread profile slices retain previous/slow/next/reference ticks
  59/60/61/110, wall 110.62/159.68/140.27/116.50 ms, all with zero overlapping
  GC. The reference shares the action-burst status. Slow/reference actions
  cost 30.49/22.91 ms, worker search 18.23/4.89 ms, movement 57.39/53.71 ms.
  Movement expands to 75.02 ms on the next tick.
  Main-thread samples show background waits and arrival processing on the
  slow tick. Helper slices include tower packing and movement kernels.
- Validation passes 6,000 nearest-spawner comparisons, mixed deterministic
  replays with 0/3 helpers, and explicit list replacement, shrink, growth,
  ordering, downstream cache invalidation and reset checks. Raw tick rows,
  early gameplay, CPU/allocation profiles, baseline source, throughput and GC
  summaries are retained in `tests/test-runs/spawner-gc-20261104/`.

## 2026-11-04: rebuild linked range stats in place

- Range and vision research or boosts now update only their linked fields in
  existing stat rows. JavaScript resolves both research and boost sources
  once per table. `k_stat_ranges` publishes pixel reach and effective vision
  directly to the existing shared Float32 table using reusable call arguments.
  The scalar path also updates existing rows in place. Missing rows still use
  the full constructor. Worker vision, level-one aliasing, SoA and AoS are covered.
- Over the same 100 settled mixed chaos ticks, sampled simulation allocations
  fell **174.54 → 150.15 MiB (14.0%)**. The full building and unit stat object
  builders account for **6.70 + 4.91 MiB** before and neither appears among the
  sampled simulation allocations after. Synthetic inputs **183.46 → 179.74
  MiB** and harness/other **84.86 → 83.59 MiB** are separate. Final diagnostic
  hashing is outside the sampling window.
- A separate warmed range-only check measured three 20,000-update passes at
  **74.80–83.32 ms** with scalar writes and **71.04–79.92 ms** with WASM.
  The median was 77.34 vs 71.43 ms. The mixed workload above measures the
  combined effect of reusing the rows and publishing derived fields in WASM.
- Two serial unprofiled pairs ran in opposite orders with production WASM32,
  11 helpers, dk1, 160 ticks and the settled window 60–159. All runs have zero
  steps above 500 ms. Each has five minor, one major and one incremental GC
  event. Both GC duration and tick tails vary across the pairs.

  | Run | Mean wall | p95 | p99 / max | >1.5× median | GC total / longest |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 110.13 ms | 143.91 ms | 167.39 ms | 2 | 70.45 / 19.85 ms |
  | Candidate A | 102.79 ms | 127.92 ms | 160.22 ms | 2 | 76.16 / 22.30 ms |
  | Reference B | 102.82 ms | 130.46 ms | 155.33 ms | 1 | 73.43 / 23.06 ms |
  | Candidate B | 107.61 ms | 138.67 ms | 167.89 ms | 1 | 71.87 / 17.89 ms |

- The initial scene has 1,000,004 units and 65,536 structures on a 1024 map.
  The measured window has **285,529–375,694 units**, with 7,541 births and
  98,325 deaths. Work counts and exact hash `338091ed` match. Reference A/B
  → candidate A/B rates per measured wall second: spawns **684.8/733.5 →
  733.6/700.7**, research deposits **181.2/194.1 → 194.2/185.5**, collector
  deposits **80.9/86.7 → 86.7/82.8**, astar deposits **75.3/80.6 → 80.6/77.0**.
  The full early gameplay series is retained, with maxima of 1.76–1.86 s.
- The twelve-thread capture retains **79/80/81/70** as previous/slow/next and
  nearby normal same-burst reference. Wall time is **90.42/147.99/130.85/120.52
  ms**. Slow/reference GC overlap is **12.54/0 ms**, worker search
  **18.26/4.91 ms**, actions **20.44/21.67 ms**, movement **51.25/56.45 ms**.
  The next tick spends **73.97 ms** in movement. The main profile shows GC
  and a background wait. Helper samples include index sorting and status
  work. Both whole-tick and action-phase slices are retained.
- Rebuilt WASM32 `f485a21df5e2c755` and WASM64 `cfb393a26c0c6112`.
  Nine correctness runs passed, including 173,880 linked-field comparisons
  on each WASM build, snapshot restoration, research rebase, and deterministic
  mixed replays with 0 and 3 helpers on both builds. The worker-mode three-peer
  replay with 3/0/2 helpers passed 378 exact peer/tick comparisons, 14 collision
  bursts and all 30 gameplay actions without repair.
- Raw tick rows, GC events, allocation and CPU profiles, source baselines,
  runners and summaries are in `tests/test-runs/stat-gc-20261104/`. Remaining
  simulation allocation hotspots include action sanitization, unit retirement,
  and spawner lookup during research capacity checks.

## 2026-11-04: native action arrivals and reusable gameplay scratch

- Continued from the settled checkerboard investigation. A fresh all-thread
  capture with action subphases found arrival marking at **7.4–8.2 ms per
  burst**: repeated ID lookups through JavaScript unit objects. Added
  `uix.rs k_uid_arrival`, which probes the existing numeric ID table, checks
  ownership and writes arrival marks directly. It returns runs of old marks
  and decrement counts for the waiting-action records. Raw selections retain
  their uncapped arrival semantics through bounded chunks; duplicates across
  chunks only supersede an earlier mark once. Existing order scratch is
  reused; no new per-action WASM buffers. Small lists and unsupported arrival
  counters/player IDs retain the scalar path.
- Two serial, opposite-order unprofiled comparisons (production WASM32,
  11 helpers, dk1, 160 ticks, settled window 60–159): action-burst mean
  **25.77/26.57 → 20.04/22.27 ms** (22.2%/16.2% less). Whole-step wall
  p95 **144.64/146.36 → 130.45/154.61 ms**, max
  **163.81/169.39 → 143.45/197.68 ms**. Each has zero ticks above 500 ms.
  **No reliable overall hitch reduction established:** the reverse-order
  candidate had worse tails; GC overlaps still reach 20–23 ms. This is an
  action-phase improvement, not elimination of GC or of all gameplay spikes.
- Previous/slow/next/reference in the baseline all-thread capture are
  **91/92/93/88**, wall **108.87/178.59/121.24/114.67 ms**. The slow tick is
  not an action burst: **31.81 ms GC**, movement **64.91 vs 52.42 ms** and
  worker search **19.39 vs 17.05 ms**. The native-arrival capture independently
  selects tick 92 (28.47 ms GC); its neighboring ticks and matching non-burst
  reference are retained too. Whole-step and action-local slices cover all
  twelve captured threads.
- Per the clarified garbage target, captured allocations separately from
  latency acceptance. Three changes remove reusable temporaries: structure
  list refills overwrite their backing arrays before truncating the tail;
  `stationaryBrainChanged` tests override maps directly without constructing
  an array and closure; action sanitization uses static field-name tables and
  indexed loops. List identity, tile order and exact visible length remain.
- Same 100 settled ticks with sampled allocations including collected objects:
  simulation-attributed **204.30 → 173.15 MiB** (15.2% less), structure-list
  refill **15.65 → 0.13 MiB**, `stationaryBrainChanged` **14.05 → 0 sampled
  MiB**. Synthetic inputs **192.56 → 183.37 MiB** and harness/other
  **253.28 → 249.98 MiB** are reported separately, not credited as production
  improvements. Final diagnostic hashing occurs outside tick timing and is
  included in harness allocation totals. Sampling is an estimate, not proof
  that a function never allocates. These captures still contain GC. The
  allocation sampler now stops before report generation and diagnostic
  hashing, so future captures exclude those final reporting allocations.
- Final unprofiled comparisons isolate the reuse changes against the already
  native-arrival implementation. Pair orders were reversed; the same settings
  and 100 settled ticks are used above. All four have zero steps above 500 ms:

  | Run | Mean wall | p95 wall | p99 / max wall | >1.5× median | GC in continuous window |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | Reference A | 125.66 ms | 161.90 ms | 239.56 ms | 1 | 72.71 ms |
  | Reuse A | 113.19 ms | 151.82 ms | 194.97 ms | 2 | 87.58 ms |
  | Reference B | 110.22 ms | 146.53 ms | 155.06 ms | 0 | 72.27 ms |
  | Reuse B | 111.52 ms | 147.83 ms | 171.47 ms | 3 | 79.77 ms |

  Allocation volume fell, but **neither fewer GC pauses nor a reliable tick
  tail improvement is established**. Each continuous settled window contains
  five minor, one major and one incremental GC event. Reference B's 20.40 ms
  major collection occurs between timed rows; `gcEntries` retains it, and
  `summary.json` reports both continuous-window and tick-overlap GC time.
  Candidate major pauses are 24.16/25.70 ms. Retained early gameplay maxima
  across these four runs are 1.83–3.05 seconds; no early ticks were hidden.
- Actual measured-wall work rates for reference A/B → reuse A/B, per second:
  spawns **600.1/684.2 → 666.2/676.2**, research deposits
  **158.8/181.1 → 176.3/179.0**, collector deposits
  **70.9/80.8 → 78.7/79.9**, astar deposits **66.0/75.2 → 73.2/74.3**.
  Counts and final exact hash `338091ed` match in all four; these variable
  rates are not a repeated throughput gain claim.
- Final all-thread capture after the reuse changes retains ticks
  **59/60/61/70** (previous/slow/next/same-burst reference): wall
  **136.80/161.58/150.99/135.38 ms**, all with **0 ms overlapping GC**.
  Slow/reference actions **30.24/25.44 ms**, worker-search phase
  **18.10/5.01 ms**, released-slot reset **6.03/0.87 ms**, movement
  **58.01/60.67 ms**; the next tick's movement expands to 82.07 ms.
  Main-thread samples include kernel/background waits, while helper slices
  retain tower preparation, status and slot-reset work. Whole-step and
  `processActions` slices use the non-GC burst reference at tick 70.
- All headless A/B settled windows contain **285,529–375,694 units**, 7,541
  births / 98,325 deaths and identical work: 7,541 spawns (5,416 army), 1,996
  research / 891 collector / 829 astar deposits, 543 construction completions,
  1,260 healer deliveries and 44 salvage returns. The initial scene has
  1,000,004 units and 65,536 structures on a 1024 map; this remains a seeded
  million-unit scene, not a sustained-million-unit measurement. The reversed
  arrival pair and both allocation captures finish with exact hash `338091ed`.
- Raw JSON/JSONL, all-thread profiles, allocation profiles, source baselines,
  serial runners and derived summaries are in
  `tests/test-runs/arrival-20261103/` (the session crossed midnight).
- Validation: **15 correctness checks pass**, including 24 native-arrival
  equivalence cases and output guards, no WASM allocations in the reserved
  arrival path, 31 structure-list membership/order/replacement/shrink checks,
  action budgets/supersession, structure targeting and snapshot restore,
  scene orders in page/worker modes, and mixed replays with 0/3 helpers.
  Six-map multiplayer chaos passes in page mode with 0 helpers and worker
  mode with 4 host helpers (2,598 tick hashes per map, only forced repairs).
  Worker-mode three-peer transport with 3/0/2 helpers passes 378 exact
  peer/tick comparisons, 14 collision bursts and all 30 gameplay actions
  without repair. Native arrival and action budgets also pass on WASM64.
  Rebuilt production WASM32 **41b8de5c2fbf3a06**, WASM64 **073abc08a9021488**.
  The expanded native test passes again on both variants, including an object
  attached to columns after entering the loose ID map (scalar fallback).
  A separate allocation-window smoke confirms diagnostic hashing is absent
  from the heap profile while its exact hash is still produced normally.
- Headless **Edge multiplayer** completed Full, Team and Team + history
  visibility with 200,000 starting units (100,000 per team), a 1024 map,
  three helpers per peer and recurring ctrl-click orders: six host/guest
  result rows, no captured errors. This is a browser integration check, not
  an A/B latency comparison. History still records a 141.4 ms host frame and
  875.58 ms p95 worker-result lateness; browser GC was not separately
  attributed, so these are not identified as GC pauses. Results and launch
  parameters are in `edge-multiplayer.json` / `edge-status.json`. The sandbox
  launch failure is retained separately; the successful run was authorized
  outside the sandbox. Browsers, correctness runners, builds, profiles and
  unprofiled timing comparisons ran separately.
- Remaining garbage sources include sanitized action objects/ID arrays,
  unit-retirement tombstones, spawner/research indexes, stat rebuilds, spawn
  objects and visual-event records. Further work should replace those with
  bounded reusable records/numeric handles, preserving generation and stale
  reference behavior. Movement/traffic/atlas CPU, worker-search waits and
  external scheduling remain separate tick costs. Eliminating GC is still
  an open objective.

## 2026-10-26: dense mixed workload and turret burst reduction

- Expanded the chaos fixture to start with 1,000,004 units and 250,000
  structures on a 1000x1000 map, real nearby worker jobs, R0–R10 research,
  paid production/healer queues, collector farms/mines, construction,
  salvage, portals, turret choke points and recurring player actions.
  Added work/throughput and population censuses, a secondary opposing
  production layout, and serial scenario comparisons. Deaths remain real:
  the dk=1 measured window contains 455k–722k surviving units, not a
  maintained million. Front production has not been proven to sustain it.
- Profiled the large scene across twelve threads. A turret phase expanded
  to 437 ms versus 47 ms in a nearby normal tick. Added spatial-entry SoA
  scratch and helper-dispatched WASM SIMD tower acquisition, using packed
  type/status filters and f64x2 distances. The first SIMD-only trial was a
  regression overall; a follow-up previous/slow/next capture found repeated
  structure searches and preparation overhead. Preparation now reads the
  existing structure SoA directly; the four-class building fallback uses
  one traversal. Scratch costs about 32 MiB, without persistent unit fields.
- Also indexed dense nearest-spawner misses and live manual-assignment
  conflicts; bounded sparse-query fallback; reduced projectile structure
  tile probes and removed a per-projectile closure. Scalar tower scans
  filter through existing dead/owner columns before object access.
- Two serial 140-step dk=1 pairs, eleven helpers, reversed order, 20 warmup
  steps: mean **408/399 → 362/364 ms**, p99 **813/695 → 565/553 ms**,
  maximum **836/719 → 617/574 ms**. Worst-5% mean **696/639 → 512/527 ms**;
  over-500-ms steps **19/14 → 2/4** out of 120 per run. These are warmed
  gameplay results. The first gameplay tick still costs about 8.4 seconds
  in this mass-created scene; all early ticks and their initialization/
  initial-command costs are retained separately, not classified as free
  pre-game loading. Do not claim all gameplay spikes have been eliminated.
- Both optimized repeats finish with hash `b304549`. Historical reference
  hashes varied between these runs, so legacy equality is diagnostic.
  Current implementation's 32-step combat replay is deterministic with
  zero versus three helpers in both WASM modes, and asserts actual SIMD
  consumption while verifying live scalar targets. Focused structure
  targeting (6,805 cases), SIMD acquisition (4,800 cases/run), projectile
  collision (6,050), dense/sparse spawner/reservation tests and both scene
  layout checks pass. A separate 45-step million-unit live SIMD verification
  also passed. Both production binaries rebuilt: `7268f4d0c6f19362` (32),
  `18802f7ca0e70ac0` (64).
- Persistent spike-hunting guidance is in `AGENTS.md`; the profile slicer
  now includes the immediately previous and next tick plus a nearby normal
  reference, across captured threads, and supports phase-local slicing.
  Benchmark output includes worst-5% mean, absolute/relative slow counts,
  excess pause time, raw early gameplay ticks and OS/GC measurements.
- Raw captures, rejected trial results and detailed limitations:
  [dense-chaos report](tests/test-runs/chaos-dense-20261026/README.md).
  A final serial dk=20 pair (100 steps, 20 warmup, 80 measured) also improved:
  mean **1167 → 1042 ms**, p95 **1540 → 1399 ms**, p99/max **1894 → 1772 ms**.
  Production-queue processing averaged **110 → 25 ms**. Population was
  401k–451k; optimized work included 28,391 births, 7,601 research deposits,
  61,313 energy and 53,736 astar deposits, and 15,406 construction completions.
  This larger-stride pair is not a repeated long-run tail guarantee: relative
  over-1.5-median counts actually rose 1 → 2 as the median fell. Peak live
  WASM memory grew 1633 → 1665 MiB, committed memory 1940 → 2182 MiB.
- Remaining costs include mass orders, worker events, movement/traffic/
  atlas work and projectile bursts. The dk=20 worst step still took 1.77 s.
  Moved the unchanged inline projectile update/compaction pass under the
  existing `projectilesAdvance` trace name, so future traces can measure its
  whole body instead of only its begin/end toggles. Focused structure,
  parallel-kernel and both-mode deterministic combat checks pass afterwards.

## 2026-10-20: collision and shared stat rows

- Vectorized stationary contact geometry; reused exact opposite-force
  rounding; kept the default contact query budget at 8 (0 unlimited).
- Paged optional unit references and interned common type/stat references
  for units, buildings and floors; removed unused separation mirrors.
- Removed six actual per-unit Float32 stat arrays (24 bytes/slot,
  91.59 MiB at 4,001,792 slots). Movement, acquisition and hit resolution
  now read stable 64-byte shared rows, with SIMD broadcast/gather paths.
  Research updates those rows without enumerating units. Remaining
  visibility/health/navigation housekeeping still uses its staggered pass.
- Added complete entity storage census, preserved cached-layout sources for
  repeatable A/B tests, process resource counters, Windows paging sampling,
  and an optional strict WPR PMU profile. WPR hardware collection is blocked
  by Windows access denied even outside the sandbox; no DRAM traffic
  improvement is claimed from footprint alone.
- Results, all raw runs and CPU profiles, validation and current limitations:
  tests/test-runs/collision-tps-20261020/README.md and comparison.md.
  The unchanged research queue panel failure also occurs in the archived
  2026-10-19 full regression results.

## Ground rules (user)

- Multiplayer is the game's main and only real mode. Solo play exists only
  to test changes (optimizations, visuals...). Every optimization must apply
  to multiplayer (host and guests, sealed ticks, patches, pace control);
  solo-only fast paths are useless as deliverables. Measure in multiplayer
  (tickbench is host + guest; tests/render-tps-bench.cjs runs a host and a
  guest page by default).
- Rendering / TPS work: test in Edge (not the app's built-in browser), in
  all three map visibility modes (Full, Team, Team + history), on large
  fixtures (50k-100k units per team) for performance; small maps are fine
  for functionality. Plan: FPS_TPS_STABILITY.md.

## How to verify and measure

- Determinism suite (both simulation modes, ~15 min):
  `node tests/run-regressions.cjs 5 --filter="multiplayer-(chaos|desync|snapshot|patch|matrix|scenarios|action-fuzz|cross|corruption|border|extremes|host-mig|late)|shared-|sim-frame|parallel|kernel-object" --output=../.reg.json`
  (`--output` is joined to `tests/`; keep it relative.)
- Kernel/object equivalence (every snapshot field, host kernels vs a guest
  running everything through `Unit.update`): `node tests/kernel-object-equivalence.test.cjs [seed:map,...]`.
  `PU=<id> PT0= PT1=` logs one unit's updates on both peers.
- Benchmark (never run two at once): `DATA=tests/100000-1000.json HELPERS=7 TOPPHASES=1 UPDSPLIT=1 KTIME=1 STATES=1 node --max-old-space-size=12000 .claude/tickbench.cjs 5`,
  plus `ACTIVE=1` (workers employed) and `BATTLE=mix` (armies fighting),
  `TOWERS=8000` (8000 towers per team in facing bands, towers engaging
  towers) and `TOWERS=8000 BATTLE=mix` (siege: armies against tower lines).
  `bash .claude/benchall.sh <outdir> <tag> base active battle towers siege`
  runs them in turn and prints p50/mean and the top phases
  (`.claude/phsum.cjs`). Diagnostics: `AFTER=1` (micro-timings of the
  serial steps), `CHASESTAT=1`, `UPDSPLIT=1` (unit updates by state).
  `PROFILE_RANGE=a,b PROFILE_OUT=file.cpuprofile` for a CPU profile,
  `node .claude/profsum.cjs file.cpuprofile [subtree]` to read it.
- Large-world paths have unit-count thresholds (`SPATIAL_PARALLEL_MIN_UNITS`,
  `SEPARATION_SLOT_MIN_UNITS`, `SNAP_HASH_KERNEL_MIN_UNITS`,
  `EFF_STATS_KERNEL_MIN_UNITS`): the small test worlds never reach them, so
  run the chaos/patch/equivalence tests also with
  `CHAOS_SIM_EVAL="SPATIAL_PARALLEL_MIN_UNITS = 0; SEPARATION_SLOT_MIN_UNITS = 0; SNAP_HASH_KERNEL_MIN_UNITS = 0; EFF_STATS_KERNEL_MIN_UNITS = 0"`
  (every peer) and, for the equivalence test, `HOST_SIM_EVAL=...` (host
  only: kernel path vs the guest's object path).
- More tickbench diagnostics: `SUBPHASES=a,b,...` (time any global
  functions as phases), `WMOVESTAT=1` (workers in moving states that ran
  `Unit.update`, by why), `WAKESTAT=1` (idle worker wakes, with the
  exact sub-reason), `EVAL="$(cat probe.js)" AFTER='expr'` for ad-hoc
  probes. A kernel's hand-back sites can be counted by re-evaluating it with
  counters (run without HELPERS so kernels run on the simulation thread).
  `PROFILE_RANGE` counts absolute ticks: the timed run starts around tick
  70 on the 1000 map (use e.g. 130,150); the profile holds both peers.

## Determinism rules learned (keep them)

- A restore disarms every unit on the restoring peer only, so the movement
  kernels must decide exactly as `Unit.update`. Anything read during the unit
  pass about *other* units must be their pass-start state: positions via
  `_unitTickX/_unitTickY/_thingTickX` (active between `unitPassBegin/End`),
  `forEachUnitInRange/forEachUnitInAreaRange(..., { tickStart: true })`.
- Spatial per-chunk/per-block unit counts are frozen during the pass
  (`spatialCountsDeferBegin/End`) so they match the tick-start unit index.
- No outcome-relevant query caches whose history can differ between peers
  (the closest-enemy chunk cache was removed).
- State the kernel maintains must live in columns shared with the object
  (`_floorTile` is the `mvFloor` column).
- Watchdogs / samplers must run on a fixed cadence, not "whenever the AI runs"
  (builder watchdog: `BUILDER_WATCH_TICKS`, parked builders wake for it).
- Kernel arming must match what `Unit.update` would do next
  (`_simMoveTryFlowArm` only when the unit's own path is used up).
- Budget checks during the pass must not depend on the order of spends
  (A* step coverage uses the budget at the pass's start).
- Interface/presentation code running in the simulation realm (frame
  details for watched units, display paths) must not touch simulation
  caches or pools: only the peer that shows a unit runs it.

## Session log

### 2026-10-08 (eighteenth round, in progress) — 400k main thread, decisions off it

- Goal (user): main-thread tick < 50 ms at 400k (200000-1000 ACTIVE+BATTLE);
  big changes, bench, repeat; main thread O(1) per event, decisions on helpers.
- 400k mean 161 -> 125 -> 109 ms (p50 146 -> 101), 0 desyncs. Done:
  movement kernels in Rust (wasm/src/mv.rs mv_step/mv_move/mv_driveby, bit-exact,
  arg block words = sim_parallel.js _SIM_MOVE_WNAMES; nav tables from word 160);
  drive-by shots after the step (Unit.update and kernel alike; mvFire + simDriveByFire);
  target died -> output 15, simTargetDiedCommit; held/chase-come-in-range attacks made
  in the kernel (mvFlags 4, atkCd/atkDmg/atkSty columns, mv.hita/hitt/hitc);
  unitHitsResolve: hits ranked by attacker id, SIM_KERNEL_HITS (60) per target on
  helpers, retaliation/watch/looks (first 512) after; chase steps (7, 9, 11, 12) not
  visited in the pass (HELD_DEAD undoes moves of units dead mid-pass, simPassWallFixups);
  lean o13/o14 commits; WORKER_MOVE_CHECK_TICKS 128; detach via one constructor;
  hash: buildings and reservations on the rotation round only, obj groups 80;
  sticky effective levels (_effSticky, kernel twin); adjacency dirty set skips empty
  256-tile blocks; separation finish 2048 a job; fliers hold over walls; statuses no
  longer disarm the movement kernel.
- Measured: MOVE/MOVE_STEP are memory bound (wbench replay 200k: wasm x1.26 / x1.0):
  next is fewer columns per unit or fewer units a tick, merging STEP into MOVE (one
  pass, P[47]), floor-item effects in the kernel (~500 hand-backs a tick at 400k),
  structure engage commit, SP_COUNTS/finish, hash remainder, worker MOVING_TO (~30 us
  a call). Round 3 bench (all of the above) was running: scratchpad p400_r3.txt.
- Probes added: .claude/probes/cand_stats.js (pass candidates by kernel output);
  kdump.js also dumps nav.*/mv.cwall.* for _simNavArrays kernels.

### 2026-10-08 (seventeenth round) — Rust/wasm kernels

- User: a Rust/wasm implementation of the separation and other heavy
  operations, as optimized as possible (SIMD; data layout reworks fine),
  benchmarked. Toolchain installed (winget Rustlang.Rustup, target
  wasm32-unknown-unknown); build `node wasm/build.cjs` (wasm/README.md).
- wasm/src/lib.rs (`no_std`, simd128) has twins of SEP_PACK, SEP_MARK,
  SEP_PAIRS, SEPARATION_FINISH, ACQ_OMT (new: the acquisition's first
  stage) and ACQ_SCAN, and flownav.js `_navFieldRow` (nav_row). A twin
  writes what its JS kernel writes, bit for bit (tests/wasm-kernels.test.cjs
  on random edge-heavy inputs, tests/separation-pairs.test.cjs, tickbench
  `WASM_GUEST=0`: a wasm host and a JS guest in lockstep, 0 desyncs in the
  200k battle and the 150k rally burst), so chunks of one job may run in
  either and peers with and without wasm agree.
- The wasm heap (src/sim/sim_wasm.js): one shared WebAssembly.Memory in
  the simulation worker; the arrays those kernels read are allocated in it
  (simHeapArray: unit columns, the unit index's entry/chunk arrays, the
  separation and acquisition buffers, mv.wall, ix.agrid, hostile tables),
  so kernels work in place; helpers instantiate the module over it (own
  stack, 4 MB scratch). Freed arrays (simHeapFree, FinalizationRegistry for
  old unit columns and the navigation's graph copies) are reused once the
  chains in flight then are done and no name binds them. Wasm memory never
  shrinks: simUnitStateReserve sizes the unit columns once before bulk
  creation (match start, whole restore): host heap 1.7 GB -> 750 MB at 200k
  (254 MB live). A page whose simulation runs in its worker keeps no heap.
  The presentation bind compared column *buffers* (all one buffer now):
  compares the arrays.
- Layout/algorithm reworks (both twins): the separation's entries as SoA
  (sep.qx/qy/qr Float32, meta, qid), PACK no longer writes per-chunk
  aggregates (139k scattered writes into 1M-chunk arrays); MARK and PAIRS
  find neighbours through the sorted entries (no chunk grid reads); pairs
  are found by the unit taking part (both: the earlier entry), over its
  full neighbourhood, bands 2 * reach rows (most units do not take part on
  a tick: they no longer pay a unit's setup). Rust only: per-row tables of
  chunk starts (pairs, on the stack), an f32x4 conservative prefilter with
  the exact f64 test for candidates, a byte table of "moved" chunks (mark),
  idle FINISH slots four at a time, acquisition rings 16 chunks at a time
  (rows; columns from the transposed owners), structures 16 tiles at a time,
  entries packed in index order, units scanned in the index's order.
  Tried and dropped: per-row narrowing of the pair window by its vertical
  gap (slower: the sqrt costs more than the candidates it saves here).
- Kernel replay on a 162k battle tick (`.claude/wbench.cjs`, one thread,
  kdump.js dumps): pairs 27.2 ms (JS before) / 22.0 (JS now) / 12.6
  (wasm); pack (+aggregates before) 11.6 / 5.9 / 3.5; mark 4.6 / 4.8 /
  2.2; finish 7.5 / 7.0 / 4.7; acquisition scan 74.4 / 73.3 / 19.5.
- Whole CPU per tick (tickbench KCPU=1, HELPERS=0, 100000-1000 ACTIVE+
  BATTLE, 6 s): JS mean 305.9 / p50 233.5 ms, wasm 250.0 / 200.0. By
  kernel (JS -> wasm, ms a tick): NAV_FIELDS 56.5 -> 34.9, SEP_PAIRS 25.4
  -> 12.6, ACQ_SCAN 19.3 -> 5.5, FINISH 7.7 -> 5.2, PACK 5.9 -> 3.4, MARK
  3.9 -> 2.0 (the ported kernels 120 -> 65 ms).
- Main thread with 7 helpers (same workload): wasm 76.4 / 65.8 / p95 122.9
  vs JS 77.1 / 66.3 / 124.6: unchanged (these kernels ran on helpers, off
  the critical path; the gain is helper capacity, the 8 x 50 ms ceiling).
  Main thread per tick: unit pass 24, simMoveRun 13, state hash 6.4, hits
  4, separation commit 3.2, status 3.0.
- Top remaining CPU (a tick, wasm): MOVE 35.6, NAV_FIELDS 34.9 (the row
  search in Rust ~12 ms a peer; KCPU counts both peers' setup ticks too),
  SEP_PAIRS 12.6, DRIVEBY 12.0, MOVE_STEP 9.8, SNAP_REGION 9.4, WS_SCAN 8.8,
  INDEX_MERGE 6.2 (serial). Next for wasm: the movement family (MOVE /
  MOVE_STEP / DRIVEBY, ~57 ms, and simMoveRun on the main thread); its
  inputs include non-heap and nested arrays (vis.cover per player) to
  flatten first.
- Tools: tickbench `WASM=0` / `WASM_GUEST=0`, `KCPU=1` (CPU per kernel,
  timed ticks only), `.claude/wbench.cjs` (JS vs wasm replay of dumps).
- Tests: the regression set (both simulation modes) passes but for
  multiplayer-patch, which fails the same way on HEAD (mode 0 flaky,
  mode 1 the same repairs at the same ticks; checked with
  DEFENCE_TEST_BASELINE=HEAD). Edge (serve-like COOP/COEP, sim worker with
  7 helpers): heap ready, no errors.

### 2026-10-05 (sixteenth round) — 400k goal, memory first

- New goal (user): 400k units, 2 teams, ~100k buildings, 100k energy and
  ★ mines; mainly the simulation thread's tick cost, jitter low, clicks
  responsive. Note: tests/300000-1000.json is 300k units *per team*
  (600k in all; spawnCounts are per player), 200000-1000 is 400k in all.
- Two peers of 300000-1000 in one tickbench process did not fit this
  16 GB laptop (paging-bound: CPU advancing ~0.5 s/s; useless timings);
  200000-1000 (400k) barely: rss 6.2 GB, typed arrays 3.85 GB, heap 1.8 GB.
- Memory probes kept in the repo: `.claude/probes/typed_mem.js` (typed
  arrays per peer by where they are reachable from; with
  `.claude/probes/topnames.cjs` for the script-level names:
  `AFTERALL="globalThis.__typedMemNames = $(cat .claude/probes/topnames.json); $(cat .claude/probes/typed_mem.js)"`),
  `.claude/probes/heapcomp.cjs` (heap snapshot of a small hosted match by
  constructor, Unit fields, holders, plain-object shapes), tickbench
  `MEMSTAT=1` (process memory after the start and the run).
- Found: `spatialUnitsComplex` was [tile][8 player slots][1 + 19 types]
  Int32 = 641 MB per peer on a 1000x1000 map (more than everything else
  together; 1531 MB of typed arrays per peer at 200k units). Now totals
  only per tile and owner (stride per player 1: 32 MB) and the per-type
  counts by 4x4-tile blocks (`spatialTypeCounts`, SPATIAL_TYPE_BLOCK,
  ~5 MB): the effective stats' same-type window sums the blocks its tile
  window touches (kernel SIM_KERNEL_EFF_UNITS / EFF_COUNT, serial
  _effWindowCount / _countNearbySameTypeUnits: the same rule), and the
  unit-type filter of range queries rules chunks out by their block
  (_spatialChunkPassesFilters; units still checked). 400k: typed arrays
  3853 -> 2708 MB (both peers). Passed: spatial-index-builds,
  shared-spatial-*, shared-unit-state, index-merge, resource-penalty-stats,
  kernel-object equivalence (default; and HOST_SIM_EVAL
  EFF_STATS_KERNEL_MIN_UNITS = 0), chaos determinism (CHAOS_HOST_HELPERS=7
  + CHAOS_SIM_EVAL, 6 maps). (Equivalence with SEPARATION_SLOT_MIN_UNITS
  = 0 on the host fails at tick 17 the same way before this change:
  pre-existing, the slot separation is not the object path's.)
- Remaining typed arrays per peer (200k): nav fields 173 MB (per node
  C*C Uint16, 5 in-use profiles), _sourceAreaZoneIds 34, _visCover.dense
  30, nav partL 21, ws.score 18, mv.areaBox 17, sep.box 15, ~20 per-tile
  Int32 grids of 4 MB, unit columns ~850 B a slot (capacity a power of
  two over 1.25x the units). Heap: Unit objects ~1.1 KB each in node
  (half with Chrome's pointer compression); no big per-unit satellites.
- Match start: the host's own row said 'ready' right after its world was
  generated while its simulation worker still loaded; now 'loading' until
  simClientWorldReady (_hostShowOwnLoadStatus).
- Unit columns grow by half in 4096-slot steps (was doubling: 1M slots of
  ~850 bytes for 600k units); a restore's compaction sizes 1.125x live.
- 400k bench before this round's tick work (200000-1000, ACTIVE=1
  BATTLE=mix, HELPERS=7, 8 s): mean 203 ms, p50 198, p95 301, 0 desyncs;
  unit pass 111 (chasers 54 ms / 12.8k calls, in range 28 / 6k, worker
  MOVING_TO 22 / 168 at 129 us each), simMoveRun 26, hash 9, separation 8.
- Kernel holds and chases were thrown away at their turn whenever any wall
  changed during the pass (_simMoveWallQ: a mine depleting anywhere, ~every
  tick with collectors at work): ~9k units a tick at 200k ran Unit.update
  for nothing. Both paths read the walls of the pass's start
  (simMoveWallGrid; changes are applied at its end), only the end of
  Unit.update reads the unit's own tile live (pushUnitOutOfBlockedTile), so
  the turn check now fails only for a change within a tile of where the
  unit started or ended (_simMoveWallQNear: a per-pass stamp grid).
  Kernel movers (outputs 1, 3) never had that check.
- Chasers whose attackTarget still named their target from a tick in range
  (doAttacking's chase leaves it) were never armed (simMoveTryChase's
  `attackTarget === tu` exclusion): ~730 a tick at 200k. Dropped: nothing
  on the chase reads attackTarget; a unit in range the hold did not take
  comes out as "come in range" (output 13, simHoldChaseCommit: what
  doAttacking's in-range branch does).
- Collectors' return trip: _findClosestSpawner walked rings of 16-tile
  buckets out from a far mine (thousands of empty buckets, ~100 us a
  return); now a scan of the owned list's tiles as typed arrays (per list,
  lists are remade on spawner changes), objects read only for candidates
  that would win (same order: distance, row, column, id).
- Status-effect column accessors are generated per column (one closure did
  c[k] for every key: a megamorphic lookup on every read).
- 200k (100000-1000, ACTIVE=1 BATTLE=mix, 6 s): mean 117.5 -> ~89-94 ms,
  p50 103 -> 77-82; chasers in Unit.update 8187 -> 788 a tick.
- Probes: `.claude/probes/attack_why.js` (attacking units that ran
  Unit.update by kind and why: armed and handed back, or the first unmet
  arming condition), `still_valid.js` (why kernel holds/chases fail their
  turn check), `handback_sites.js` (which `ON[s] = 0` site of _simMovePre
  fired, by armed mode; run with HELPERS=0: the patched copy must run on
  the simulation thread; plain no-HELPERS runs another (non-shared) mode
  that hardly fights), `.claude/srcline.cjs` (harness profile line ->
  file:line; ~3 lines early). Probe pitfall: the harness evaluates the game
  in a function scope, so a re-evaluated game function must be made with a
  direct eval in a block whose names the function does not use (a helper
  with `H` in scope, or a global eval, desynced the peer).
- At 200k, hand-backs left per tick (HELPERS=0 probe): 2404 attack-movers
  engaging (the acquisition tier found a target), 1212 holds and 564 chases
  whose target died, 547 drive-by finds: state transitions, a whole
  Unit.update each (~3-4 us).
- 400k after the hold/chase/spawner changes: mean 203 -> 160 ms, p50 198
  -> 141 (unit pass 111 -> 67), 0 desyncs; rss at start 6111 -> 5451 MB.
- Engagements without Unit.update: an attack-mover or idle unit whose aggro
  look (the acquisition tier's target, on its acquisition tick) found a
  unit was handed back (~2.4k a tick at 200k) for doAttackMoving/doIdle's
  first branch. Now kernel output 14 (it stands); at its turn
  simEngageCommit does what Unit.update would there (target, unforced,
  attacking; push out, index, re-armed), after checks as a hold's (alive,
  no wall change by it, the same tier answer via _combatScanTarget); else
  Unit.update. 200k: c2 updates 2945 -> 163 a tick.
- Cloud-tower tables (pathfinding.js) were keyed on pathTopologyVersion:
  every mine depleted or building placed or lost anywhere rebuilt them by
  walking all towers (~20k) at the next lookup - ~4 times a tick in a
  battle, inside canUnitOccupyTile (pushUnitOutOfBlockedTile of collectors
  on mine tiles: ~30 us a call). Now keyed on cloudTowersVersion (bumped by
  towerJoinedOrLeft only for clouds) and the towers list's identity; the
  cloud signature (live state) stays per topology version. Worker
  MOVING_TO 7.3 -> 2.7 ms a tick at 200k.
- pushUnitOutOfBlockedTile answers from the live tile type first (not a
  wall: occupiable), before the unit's cache fields.
- 200k now: mean 85.1, p50 73.2, p95 125.8 (from 117.5 / 103 / 188).
- Total CPU per tick (HELPERS=0, all kernels on the simulation thread,
  200k ACTIVE+BATTLE): ~290 ms, i.e. ~580 ms at 400k: over the 8 cores x
  50 ms ceiling, so total work must shrink. By kernel (ms a tick):
  acquisition scan 38, separation ~60 (pairs 32, aggregate 9, finish 8.6,
  pack 6.3, mark 3.8), movement ~35 (pre-pass 14, step 8, flow 6.3, rows
  6.4, _simNavArrays 4.5), unit index ~16 (merge 7, keys 4.4, fill 4.1),
  hash region 12.6, worker search 9, status 5, drive-by 4.4.
- Acquisition scan: attacking units (most of a battle's) were scanned every
  cycle though only units attacking a structure read the answer (and idle /
  attack-moving ones). Unit.targetBuilding is now an accessor (value in
  _tb, SIM_UNIT_EXTRA_ACCESSORS) mirroring "has a structure target" into a
  column (acqB); ACQ_SNAP flags units attacking a unit (4) and the scan
  skips them. Every live unit now commits "none" unless scanned (one left
  as it was kept a result from before a restore that set the clock back,
  whose stamp could equal a later commit's: multiplayer-snapshot caught it
  with the skip).
- State hash region kernel (SIM_KERNEL_SNAP_REGION, the sums path): walks
  the slots in order (live and not dead: the listed units) instead of the
  units list through the slot map (every unit's position read out of order
  each tick); a second pass over the list gives its order hash and the
  units without a slot. snap.reg / snap.hc / snap.rot are by slot then;
  snap.noslot holds unit indexes and -(slot + 1) for slots outside the
  summed regions. CPU -17% (its float divisions and modulo per slot left).
- _simNavArrays / _simNavWalls (each movement job built ~80 registry keys
  as strings): cached per thread until a binding changes (_simParBinds,
  counted by simParallelBind and the helpers' bind handler) or another
  registry is passed (tests).
- Short attack holds (reach <= 1): an in-range-by-areas result depends only
  on the unit's window, the target's tile and the area layout, so the
  kernel keeps it in mvHWin / mvHTT / mvHVer (the long holds' keys, unused
  by short ones; simMoveTryHold and the chase->hold step clear mvHVer) and
  skips _simUnitInAttackRange while they stand; contact (touching) results
  are not kept.
- 400k (ACTIVE+BATTLE) before the hold cache: mean 139.6, p50 127.3, p95
  195, max 507, 0 desyncs (from 203 / 198 / 301 at the round's start).
  Main thread per tick: unit pass 48.3 (in range 7.3 / 1683 calls, moving
  6.9 / 1238, chasing 6.6 / 1349, RETURNING_FOR_GOLD 5.5 / 857, MOVING_TO
  3.6 / 168, attack-moving 3.0 / 662), simMoveRun 24.8 (kernel wall: move
  11.1, drive-by 7.3, step 3.9), hash 8.8, separation commit 6.4 (finish
  kernel 3.7), hits 6.0, adjacency 5.0, effective stats 5.0, collect 3.6,
  status 3.5 (kernel 2.1), visibility sync 2.1, nav fields flush 2.0.
- Tools: `.claude/profbreak.cjs` (host thread per tick by phase: inclusive
  and self per function with file:line; needs the profiled code unchanged,
  line numbers map through the current files).
- Pre-existing, not from this round (the stashed baseline fails the same
  way): tests/multiplayer-patch.test.cjs ("restored guest differs from host
  N ticks after the restore": attackTarget of a unit pointing at a dead
  unit, which is serialized by value).
- Kernel/object equivalence: new EQ_TOWERS=n (weak towers scattered over
  the middle at a safe tick) and the count of holds/chases kept next to a
  mid-pass wall change ('wall-change holds/chases kept': 0-7 per default
  seed). Pre-existing, not from this round (same on the stashed baseline):
  with EQ_TOWERS=40, seeds 13:crossroads and 9:crossroads differ in
  effectiveStacks (host 8, objects 12) at ticks 42-67, and 11:crossroads in
  exact hashes from tick 27 for 13 ticks: to look into (the guest there
  disarms every unit each tick, which may take another stats path).

### 2026-10-04 (fifteenth round) — workers walk and work again, browser scale

- Workers (user: a builder in tests/oneofall.json sent 10 tiles up did not
  move; collectors could not reach a mine among mines). Cause: the flow
  navigation had two profiles (ground, air) and every ground unit used
  the ground's walls, but builders may walk over their owner's buildings
  and collectors over active mines (canUnitOccupyTile). A builder inside
  its base's ring had no way out; a mine inside mines had none in. Now
  walk classes (flownav.js navProfileOf): profile 2 collectors (active
  gold and ★ mines open), 3 + p a player's builders and salvagers (its own
  buildings open; up to NAV_BUILD_PLAYERS = 8 players, others keep the
  ground's). Their walls (_navClassWalls, bound as mv.cwall.<p> for the
  movement kernel's slides) follow tile and entity changes per tile
  (navClassTileChanged from simMoveTileTypeChanged /
  simMoveTileEntityChanged, deferred with the unit pass's wall changes);
  each profile has its own build, rebuilt round-robin when its walls
  differ (_navDiff per profile); all in-use profiles build at the first
  tick. The kernel picks a unit's arrays by its profile column (mvNP,
  set by simFlowArm). Snapshots carry the profiles' build numbers.
- Salvagers (found by the new test): a marked building inside its
  owner's cluster had no open neighbour on the ground, the salvager stood
  in MOVING_TO forever. They now walk with the builders' class (navigation,
  canUnitOccupyTile, getPathCanWalkForUnit): their work is at their own
  buildings too.
- Flyers' detour (found by the test: healers and researchers went a
  cluster out of their way): _navFieldRow seeded every node of the
  destination's field at distance 0, so any exit into the field was as
  good as another. Seeds now start at their field distance (a sorted seed
  list let into the bucket queue as the search reaches each distance);
  rows are keyed per destination tile (no sharing between destinations
  of one field: their seeds differ). nav-rows still equals its own
  searches.
- tests/worker-walk.test.cjs (multiplayer, host + guest): one worker of
  every kind sent 10 tiles in four directions (must come within a tile
  during the move; a builder starts inside its ring of towers), then
  work left alone: collectors deliver, builders' building energy rises
  (sites and repairs: the fixture's buildings start low), the salvager
  takes down a marked tower in the middle of the base, healers spend
  their loads (spawn queues, hurt units), the researcher researches
  (queued research), and collectors sent to a gold mine ringed by ★ mines
  collect from it (made on every peer at one safe tick). Peers agree.
  Passes; nav-rows, nav-reach, nav-background, nav-build-kernels,
  nav-crowd-arrival, kernel-object-equivalence, collector-farms,
  worker-target-index, chaos determinism (7 host helpers, sim eval),
  snapshot, desync-recovery, lane-params-poison, sim-frame-replica pass.
- Left: a worker whose target has no way at all (walled in by others)
  still stands in its moving state (navPathTo gives the node; the follow
  waits); the A* era dropped such targets. navPathReach (reachability by
  component, O(1)) could make _requestWorkerPath return null there, but
  most callers re-ask every tick on null: needs a per-state look first.
- tests/render-tps-bench.cjs: PHASES=1 (the simulation worker's time per
  tick in the top-level parts, wrappers put in through its debugEval) and
  PROFILE_WORKERS=1 with PROFILE_VIEW (CPU profiles of every worker: the
  simulation worker, its helpers, the presentation worker, through a
  browser CDP session).
- Browser at 200k (the user saw ~2 TPS locally): a plain `python -m
  http.server` on Windows serves .js as text/plain, the coi-serviceworker
  is refused (SecurityError), the page is not cross-origin isolated: no
  SharedArrayBuffer, no helpers, one thread. `rng/defence3/serve.py` serves
  with COOP/COEP (credentialless) and right MIME types; the FPS counter
  says "/ 1 thread" (red, with a tooltip) when not isolated. One solo Edge
  page at 100000-1000 (moving) runs 20 TPS (sim ~25-38 ms a tick); two
  peers on this laptop do not (each gets half of it).
- Jitter (units drawn "smooth, hitch, smooth"): the presentation table
  advanced 2-3 ticks at a time, ~8 updates a second. Causes and fixes:
  presentation frames were relayed through the simulation worker (queued
  behind ticks): now a MessageChannel page <-> presentation worker (frames
  and buffer returns); the reader's frame build took 120-400 ms at 200k:
  its loop ran mostly in the interpreter (a long loop inside draw() was
  compiled on the stack before draw's later code had run and deoptimized
  at its end every frame) and wrote ~30 columns a unit: now fillUnits, its
  own function, column by column (memcpy for the metadata): ~25 ms; the
  reader copied positions from the live columns and lost the race with
  the next tick: the simulation now snapshots x, y, prevX, prevY at each
  tick's end (3 rotating shared buffers, ~1 ms memcpy) and the reader
  takes the newest. Result: the table advances exactly one tick per
  update, gaps 33-67 ms (p5-p95). The remaining unevenness was the
  simulation's own steps (crowd pushes: a free unit's step 1.9-5 px tick
  to tick; crowd stop-and-go): the reader now draws positions smoothed
  (VIS_FOLLOW 0.35 of the way to the simulation's each tick, snap past 64
  px or on slot reuse): the user prefers smooth with lag to exact.
  tests/render-tps-bench.cjs reports jitter (drawn speed per frame of
  sampled moving units, the table's advance and arrival gaps, the
  simulation's own step regularity) and LOADS=selectall (everything
  selected, rallies set, units moving).
- Page work (the user's Edge profile: _col getters, rally clicks,
  selection): getActiveUnits / getActiveEntities fast path (no subgroup
  off: no key string per thing); updateControlGroupBar's O(selection) part
  at most 4x a second; bottom bar counts twice a second; minimap 4 Hz for
  big maps; area state sent and applied only when it changes (dirtyAreas;
  it was a pass over every area plus a Map each tick on both threads); the
  click target scans and box selection still walk all units (to do: the
  frame's columns); selection overlay boxes from columns; watch lists 32
  units / 32 structures for big selections. Select-all far view 5.6 -> 105
  FPS.
- Close zoom (4-6 FPS at 200k): getChunkRenderView rebuilt a bucket index
  of all units each tick through views (now a column scan per tick, ~1
  ms; structures' index only when their lists change); the team range
  outline walked every unit's view (now the GPU: drawRangeVisibility
  outlines the simulation's sight grid, a texture uploaded per tick; other
  range modes still trace sources, from columns); per-unit detail by drawn
  size within budgets (600 units, 600 structures incl. floor items; the
  rest the GPU's column glyphs with the same size rule, uDetail /
  uDetailS), not by zoom: a tilted view's far side is glyphs; large
  selections outlined on the GPU (drawSelectionMask: a footprint mask of
  the selected slots and buildings, outlined, interpolated every frame:
  no lag); order markers (moves, attack moves, rallies) at a fixed screen
  size at every zoom for 4 s, rally points of selected spawners
  (deduplicated, 64 max) twice a second; per-unit move lines only for
  selections <= 300; salvage crosses from per-tick lists;
  getSpawnerRallyTargetWorld by id (was units.find per spawner per frame).
- Edge 100000-1000, Full visibility (FPS / frame p50,p95,p99 / TPS):
  moving 2d-close 112 / 8.3,8.6,25 / 20; 3d-close 109 / 8.3,16.6,33 / 18.6;
  tilted 72 / 8.4,33,42 / 17.2; 3d-far 111; 2d-far 105. Select-all:
  2d-close 106, 3d-close 103, tilted 59, 3d-far 105, 2d-far 105 (from
  2-6 FPS at the start of this round). Next: frame spikes (p99 25-90 ms,
  maxima to 270 ms), the tilted view, sim TPS margin at 200k (17-20),
  background texture detail on big maps, match start and the loading
  popup, click/selection scans, GPU-instanced detailed models.
- Clicks with everything selected (CLICKS=n in render-tps-bench: real
  ctrl + right clicks): one pass classifies the selection
  (getActiveUnitClasses; the handler filtered 100k units through views
  per worker type), click candidates and box selection from the frame's
  columns near the point, the multi-point split on a page worker
  (src/sim/assign_worker.js; the page packs positions, ~1 ms, the orders
  follow its answer; a click's marker shows at once), no forced info
  panel rebuild after a command while the panel is expensive. 10 rapid
  ctrl clicks, select-all 2d-far: 66 -> 100 FPS, max frame 1.3 s -> 92 ms.
- Presentation pump on the simulation thread: cells copied only when a
  tile changed (or every 5 s), the metadata cycle rests 250 ms, a slice
  waits for a tick due within 2 ms. Index wait 6-10 -> 0.75 ms a tick.
- Fog modes on the GPU and off the threads that matter: the simulation
  worker no longer runs updateVisualVisibility (presentation only; it
  walked every tile each tick, and in Team + history snapshotted what was
  seen: ~120 ms ticks); the fog is the ground shader's (a light grid
  texture, bilinear, the same curve: no canvas, blur or upload made on the
  page); the light easing, the explored grid and the history floor are
  computed by the presentation worker into shared grids (updateFog); the
  page follows their version. Team + history: units are drawn frozen where
  last seen (presentation worker applyGhosts, by the eased light, SIM_UF_
  GHOST, dimmed by the glyph shader), remembered structures refresh every
  4 ticks; the history view always carries the live unit list (a stale
  one between ticks drew units another way: groups blinked). Far structures
  of a remembered view are an instance glyph layer. Team: 10 -> ~105 FPS;
  Team + history: 2-9 -> 70-90 FPS.
- Stable detail: the unit and structure splits start over 125% of their
  budgets and end under 80%; per unit 85% / 115% hysteresis on an eased
  threshold; the GPU skips exactly the units the CPU drew (a per-slot mask)
  - units no longer flip between models and glyphs.
- Area outlines drawn by the ground shader (per-tile area ids + area
  colors as textures, a pixel-width line inside area borders, faded out
  under ~3 px tiles): crisp on 1000x1000 maps; no longer baked.
- Match start: peers report ready once their simulation worker has the
  world ('started'), the host starts the countdown only when its own has
  too (the popup used to close while workers still loaded). The worker
  reports its start timings (startGame, parse, apply, encodeWorld).

### 2026-10-04 (fourteenth round) — rebuild steps off the simulation thread, forced targets in the kernels, shrines

- Shrines (user): no bounty drops on the map any more (main.js removal
  loop). A unit's lost energy always goes to its owner's 💀 shrine
  (shrineDamageTaken no longer gated); the shrines setting only decides
  draining: off = drain mode 0, shrineDrain orders ignored, no drain
  buttons (the 💀 count and its rate stay in the HUD). tests/shrine.test.cjs
  checks the off mode too. (droppedItems and the workers' pickup of them
  are now unused: nothing creates drops.)
- Rebuild timing probe kept in the repo: `.claude/probes/rebuild_walls.js`
  (EVALALL: a 500-tile wall line at gameTime 200 on every peer),
  `rebuild_time.js` (EVAL: per tick gameTick / navTick / flush ms, the
  job step, stage/install events, sub-timings of the build stages and
  simParallelRun by kernel for ticks with navTick > 2 ms),
  `rebuild_after.js` (AFTER). With DATA=tests/100000-1000.json HELPERS=7
  RALLY10=all, 20 s.
  Before this round: install tick 4.2 ms (the window works: no remake-all
  spike), stage 3-6.7 ms, but step 1 (navBuildNodes) 46 ms (107-119 ms
  tick): the two step-cost passes as synchronous kernels 33 ms (helpers
  busy with lane work), the exit-node loop ~13 ms; step S+2 navBuildGraph
  11 ms (JS arrays of 108k edges).
- Now every pass over the map or the nodes of a rebuild is a background
  kernel on lane SIM_LANE_LONG, the simulation thread only does
  O(clusters + nodes) at a step (flownav.js NAV_STEP_*): step 1 posts
  costs (2 passes) + exit nodes (new SIM_KERNEL_NAV_NODES: per cluster its
  N, W, E, S border spans into slots), step 4 numbers them
  (navBuildNodesFinish: pairs by place) and posts local fields + edge
  counts (new SIM_KERNEL_NAV_GRAPH mode 0), NAV_STEP_GRAPH places the
  edges (prefix sums) and posts edges (mode 1) + parts, NAV_STEP_STAGE
  finishes and stages, NAV_STEP_INSTALL installs. NAV_BUILD_TICKS 142 ->
  145. Same nodes, order, pairs, edges and costs as before
  (tests/nav-build-kernels.test.cjs: against the old loops as a
  reference, at once and staged, 6 random maps).
  Probe after: navTick at step 1 0.3 ms (was 46), node numbering 2 ms,
  graph step 0.8 (was 11.7), stage 7.6 (parts union-find 3.6 + staging
  3.7: next candidate), install 3.8. Whole run mean 32.9 / p95 40.8 / max
  60 ms (before 41-45 / 52-78 / 107-170 over two runs); the state hash at
  tick 300 equal to before's (e2f426ad/e432d63e), 0 desyncs.
- Forced attack targets (orders, retaliation) in the hold and chase
  kernels: mvFlags 8. The last seen position became columns fLsX/fLsY
  (NaN = null; accessors on Unit, SIM_UNIT_EXTRA_ACCESSORS for snapshots,
  detach copies them); the kernel writes it when the target's area is in
  sight (its previous value saved in fLsPX/fLsPY, fLsT = tick) and
  Unit.update puts it back first thing when the unit runs after all that
  tick (simForcedSeenUndo); out of sight the kernel hands back (contact
  counts in doAttacking). No leash for forced chases. simChaseStillValid
  checks the forced flag against bit 8.
- Versions bumped: index.html, sim_helper.js imports, sim_worker.js
  (helper URL and its blob parts were stale: 20261018/20261012),
  sim_client.js / sim_shadow.js worker URL.
- Passed: nav-rows, nav-reach, nav-background, nav-build-kernels,
  lane-params-poison, background-chain, kernel-object equivalence (default
  seeds and 5:crossroads,3:islands,11:crossroads,21:solar_system; forced
  kernel unit-ticks 696 / 289 / 177 on the first three: the test now
  counts them), CHAOS_HOST_HELPERS=7 + CHAOS_SIM_EVAL chaos (6 maps),
  snapshot, patch, shrine.
- ACTIONS bench (`DATA=tests/100000-1000.json HELPERS=7 ACTIONS=15
  ACTIONS_TRAPS=1000 TOPPHASES=1 UPDSPLIT=1`, 20 s; 44570 traps placed at
  the setup): mean 88.5, p95 149, max 644 ms. Adjacency 17.3 ms a tick on
  average, 50-77 ms on every tick for ~200 ticks after the placement: the
  dirty-tile Set (230k tiles) copied and sorted every tick to take its
  first 1200. Now _AdjDirtySet (data_state.js): a flag per tile, count,
  lowest tile, and the hash's order-free sum kept as tiles come and go
  (same hash values); takeFirst scans from the lowest tile; the state hash
  reads the sum instead of walking the set. tests/adjacency-dirty-set
  (against a Set and a sort, 200k random operations). After: adjacency
  0.55 ms a tick; mean 73.7, p95 104, max 327.
- Forced targets in that bench: the 337 forced chasers a tick in
  Unit.update are all units on their first update after an attack order,
  never armed, target out of sight (doAttacking sends them to its last
  seen position): an order's cost, not a chase the kernel could take
  (`.claude/probes/forced_why.js`). The kernel change shows in fights
  (retaliation, targets in sight): equivalence test counts.
  Still in that bench: 9k moving combat units and 1.4k MANUAL_MOVE workers
  run Unit.update a tick (12.7 + 6.6 ms; probe `move_why.js`), simMoveRun
  14, resyncAfterTick 9.5; burst ticks: processActions 90-119 ms (per-unit
  attack / attackBuilding / hold / stop application, id Sets, 300
  queueUnit) and the unit pass after them 87-178 ms.
- Held movers parked (unit.js simMoveTryParkHeld): ~9k units a tick in
  that bench were moving with holdPosition (a hold, then a move order:
  hold keeps orders, followPath stands them) and never armed, each running
  a near-empty Unit.update. Now parked (mvOn 2) with a waiting mover's
  looks: drive-by (flags 1, mvReachD) when moving, aggro (16, mvReachA)
  when attack-moving; woken at its phase of SIM_IDLE_PARK_TICKS, by a
  release (stop disarms) or new orders (setters disarm). Only with a path
  left (without one, its look for a way is Unit.update's). Equivalence
  (default seeds) passed. ACTIONS: moving combat updates 9056 -> 467 a
  tick, unit pass 23 -> 12 ms, mean 73.7 -> 62.8, p95 104 -> 84.6.
- Player-sent workers (MANUAL_MOVE, flow mvWk 2) are no longer handed
  back on their WORKER_MOVE_CHECK_TICKS ticks: with their path not done
  the check only re-sets commandState (a disarm and re-arm). Only task
  workers (mvWk 1) are (sim_parallel.js, three places). ACTIONS:
  MANUAL_MOVE updates 1376 -> 24 a tick, unit pass 12 -> 4.6 ms; mean
  62.8 -> 54.2, p50 46.5, p95 78.9, max 257 (from 88.5 / 149 / 644 at
  the round's start). Equivalence passed.
- Next for order bursts: a burst tick is still ~200-250 ms here
  (processActions 63-105: per-unit application of hold / stop / attack /
  attackBuilding, 4 x 7.9k units a player; the unit pass after it 80-100:
  one Unit.update per re-ordered unit). Ideas: arm units in the order
  handler where their next update would only arm them (hold: park held
  movers at once), cheaper per-unit application (no id Sets), or the
  order queue for those actions too (bounded per tick, more latency).
  Also resyncAfterTick ~9.4 ms a tick there (the unit-region hash kernel
  waited for, the static part with 44k traps).
- Rendering phase, step 1 (FPS_TPS_STABILITY.md section 1, started):
  ticks dispatched ahead to the simulation worker with deadlines.
  sim_worker.js: ticks and requests are one ordered stream (_simStream): a
  tick runs at its deadline (absolute time, the page's tick clock) or at
  once when late / without one; requests run in order (patches, encodes,
  test evals land between the right ticks); applySnapshot drops the queued
  old-epoch ticks (requests before it still run); the worker publishes its
  last tick in a shared block (_simCtl: [epoch, tick]) and reports each
  tick's lateness and finish time. sim_client.js: with shared memory
  (crossOriginIsolated), ready ticks (multiplayer: sealed, commands final:
  no added input delay) are kept SIM_CLIENT_LEAD_TICKS = 3 ahead of the
  worker, gated by its shared progress (never by results the page applied;
  a bound of 8 unapplied results stays), catch-up ticks (a guest behind)
  without deadline; ?simahead=0 turns it off for comparisons. Pace feedback:
  netNoteSimulationTick takes the worker's finish time and cost (not the
  page's apply time); netSimulationBusy (dispatch-ahead) counts the worker's
  cost, its lateness and page frames longer than the lead, not ordinary
  frame times. Page: the once-a-second stats sample gathers a slice a tick
  (gameStatsStep; it scanned all units, up to ~70 ms). The harness: page
  window.crossOriginIsolated under SIM_SHARED=1; the worker's progress
  block reaches the page with each reply (simWorkerMs models a tick that
  long). tests/render-tps-bench.cjs: Edge, multiplayer host + guest pages
  (separate contexts, PeerJS loopback), FIXTURES, VIS, LOADS, VIEWS,
  QUERY, SIMHELPERS. (A first solo-only version of this was replaced: see
  the ground rules.) Early ticks take their slot of the page's tick
  accumulator (it goes below zero while ahead): without that "due" stayed
  true and every not-yet-sealed tick counted as a stall (netCounters,
  the auto input delay), which failed multiplayer-patch ("host waited
  450ms for someone else's patch") and desync-recovery under
  SIM_SHARED=1 SIM_WORKER=1. Chaos determinism, snapshot and
  sim-frame-replica passed in that mode; patch then passed too (first
  patch after ~500 ms instead of 740-1120). Two more fixes: early
  dispatch is also bounded by the real-time schedule (accumulator above
  -(lead - 1) ticks; without deadlines (the harness has no timeOrigin)
  desync-recovery ran at 41 of 20 TPS), and a tick due while the worker
  holds the whole lead marks the peer behind for a second
  (simClientNoteBehind -> netSimulationBusy), the old "results in flight
  at the limit" signal the pace control needs (backlog-fairness: a slow
  guest worker). Then, with SIM_SHARED=1 SIM_WORKER=1 (multiplayer through
  the worker, dispatch ahead): backlog-fairness passed with lower visible
  command latency (slow guest 1509 / 1495 ms vs 1707 / 1753 before; slow
  host 1716 / 1696 vs 2617 / 2613), desync-recovery 20.0 of 20 TPS, patch,
  chaos (6 maps), snapshot, sim-frame-replica. Default mode (no shared
  memory: the old dispatch) passes as before.
- First Edge multiplayer runs (host + guest pages on this laptop, 3
  helpers each, 100000-1000, Team + history, moving): both peers simulate
  all 200k units on 4 threads while sharing 8 cores, ~150-190 ms a tick
  (~3 TPS) with rendering off; the tilted 3D view made the host's frames
  ~1.2 s (0.8 TPS for both: lockstep waits for the slowest page). Two
  peers x 100k per team on one machine is not a usable setup (CPU-bound
  before rendering): multiplayer measurements on 50000-200, single-peer
  scale on the solo test bed. Frame times must come down: no dispatch
  lead hides second-long frames.
- Found by testing Team + history (pre-existing): every barrack threw in
  the 3D renderer each frame in the non-full visibility modes
  (getVisualUnitSourceLight: a barrack view has a unitType and _frameView
  but no _col: "unit._col is not a function"). Unit views only now.
- Found, pre-existing (the committed code fails the same way): the
  equivalence test's HOST_SIM_EVAL mode; render-frame-stability
  ("interpolation never runs backwards within a tick": 4 back steps). With the four thresholds at 0
  on the host only, seed 5 islands differs at tick 17 (positions,
  _sepMoved: the separation slot path is not the object path); without
  SEPARATION_SLOT_MIN_UNITS it ends with 38 repairs on the object guest
  (likely the host-only hash kernel). The mode needs revisiting (which
  host-only paths are meant to equal the object path).

### 2026-10-04 (thirteenth round) — destination fields off the simulation thread

- New fields in the background: lane SIM_LANE_NAV (sim_parallel.js). Fields
  asked for before a tick's flush are started there and taken (marked made)
  at the next tick's flush (_navFieldsStart / _navFieldsCommit), a fixed
  tick on every peer; navFieldReadyTick is now +1 / +2. The movement
  kernel checks a unit's ready tick before the made flag (a restored peer
  has them made early: same result). Arrays a job writes are only replaced
  after waiting for it (_navFieldsGrow, navPublish, sync makes).
- Rebuild window (_navNext, NAV_SWAP_TICKS = 10, lane SIM_LANE_NAVX): at
  step 2S+3 the new build is staged, not installed; every live field is
  made over it in the background into second arrays (list id 2), fields
  asked for meanwhile over both builds (list id 1 in their jobs); at step
  2S+3+10 both are installed at once (navPublish(nav, true): no remake-all).
  No sweep drops during a window. NAV_BUILD_TICKS includes the window.
  Measured before the window: a rebuild's remake-all at 3923 live fields
  was 61 ms on one flush (113 ms tick).
- Rally (2 rounds, machine ~15% slower than rally21 that day): background
  fields mean 36.9 / p95 44.2 vs synchronous 35.7 / 43.5 (noise);
  navFieldsFlush max 10.5 -> 1.5 ms.
- tests/nav-rows.test.cjs: fields and rows checked against their own
  searches before / in / after a rebuild window, with 3 helpers and none.
- Passed with the window: kernel-object equivalence (default + 5,3,11,21),
  CHAOS_HOST_HELPERS=7 chaos (5 maps), snapshot, patch, nav-reach,
  nav-background, background-chain. Still to do: the rebuild probe (AFTER=after_rebuild.js style: walls
  toggled, gameTick and flush timed with __scratch.realNow) to confirm the
  install tick no longer spikes. Bump `?v=` for flownav.js, sim_parallel.js.
- Next: forced attack targets in the chase/hold kernels (flag bit 8 is
  free; _forcedTargetLastSeenX/Y as column accessors (NaN = null), kernel
  writes them on visibility with the previous value saved and restored at
  the top of Unit.update when written this tick; leash skipped for forced),
  then ACTIONS bench (UPDTICK), adjacency recalculation, order bursts.

### 2026-10-04 (twelfth round) — every unit on the flow navigation, no searches on the simulation thread

User direction: no A* (or other search) on the main thread, ever; every unit
(normal, attacking, worker, flyer) moves by the flow navigation; a
destination it cannot reach sends it to the closest tile it can reach,
worked out in the background; no unit counts as arrived until it is on its
tile; the main thread only makes O(1) checks, the helpers do the rest.

Navigation (flownav.js):
- Parts: a cluster's walkable tiles connected inside it (helper kernel
  SIM_KERNEL_NAV_PARTS, a background stage of a rebuild); components: parts
  joined by exits (union-find at the build's end). Per tile partL (Uint16),
  per part its component; navCompOf / navReachable are O(1).
- The global hop table (one Dijkstra per destination cluster per rebuild,
  ~1024 on the 1000 map, and wrong for clusters split by walls: a unit on the
  other side of a wall inside a cluster had no way, as in mazes) is gone.
  Each destination field now carries a row: every part's exit toward it
  (_navFieldRow: one Dijkstra over the exit graph from the field's nodes
  that reach the destination, by the helpers in SIM_KERNEL_NAV_FIELDS).
  simNavStep / simFlowLook read the row by the tile's part.
- Unreachable destinations: navPathSubstitute asks the helpers for the
  closest tile of the unit's component (SIM_KERNEL_NAV_SUBST at the flush:
  the component's parts by cluster distance, then their tiles while a nearer
  one may be found); the answer is used NAV_SUB_TICKS later on every peer
  (whatever a peer has cached; a restore asks again for the waiting units).
  The unit keeps its target (_pendingPathTarget: sub, at, ver): it goes to
  the closest tile and waits there, parked (simMoveTryParkWait) between
  looks every NAV_GOAL_RECHECK_TICKS (at its own phase); a look is O(1)
  (the build's seq unchanged: nothing to do); a new build (nav.seq,
  snapshotted) makes it ask again, and it goes on when it can.
- A unit standing on a wall tile (a building put down under it) steps out
  to a side neighbour whose part has a way (_simWallStepOut); the reach test
  takes any open neighbour. simFlowSlide never blocks a step inside the
  unit's own tile (pre-existing: a builder on its tower's tile froze for good,
  its committed step zeroed every steer: tests/laser-activation).
Callers: _findPathForUnitTagged / _makeFallbackPathForUnit /
_tryUpgradeAstarFallbackPath are navigation only; move orders put every unit
on the destination's flow (workers sent by the player too; small orders, under
NAV_GROUP_MIN = 8, on the narrow field without crowd settling); the group
routes and the deferred group search are no longer used (advanceGroupRoutes
was 30-120 ms a tick in the ACTIONS workload); flow orders split units by
component, not by the path regions. Kernel worker kind (mvWk): 1 a worker at
its task (stands where the way ends, its task looks again), 2 one the player
sent (handed back: goes to the closest tile). The one deliberate "short of
the tile": a group's units settling beside their own idle crowd within 8
tiles of the group's destination.

Also fixed (failing before this round): the unit-by-id map rebuilds when
its size disagrees with the unit list (units pushed directly: tests; the
corruption fuzz's injected unit); camera-interactions accepts the centred
camera when zoomed out past the map; render-frame-stability checks the new
scale-rendering path separately (counts per frame) and its layered checks
with __disableScaleRendering; pathfinding-routing tests the A* engine as a
library (findPathAStarTagged; units no longer use it).

Tests: tests/nav-reach.test.cjs (new: a split cluster crossed; units outside
a walled ring wait at its nearest side with their order kept, then reach the
destination after a wall opens; a walled-in unit at the ring's side nearest
its target; no search ran), nav-background compares the parts.

### 2026-10-03 (eleventh round) — click ticks, cold kernels (deopts), split movement kernels

Same target and bench as the tenth round. New bench option RALLY_ROUNDS=2
(a second round of the 10 clicks 3 s after the first, other points): the
first round is cold (a freshly loaded save), the second warm.

Fixed / changed:
- Lockstep packet and bundle checksums stream the stable serialization's
  characters into FNV (main.js hashStableLockstep) instead of building the
  string (a click's 180k ids made MBs of string). Same values
  (tests/lockstep-hash-stream.test.cjs, 3000 random payloads).
- Flow orders take the units directly (no {u, ugx, ugy} wrapper per unit);
  the supersede lookups cache the last entry (_orderSupSeq/_orderSupEntry).
- Effective stats: units behind the stat tables refreshed at most
  EFF_BEHIND_PER_TICK (1500) a tick (a research step made 40k at once).
- Unit constructor: the fields an order writes declared together (one or
  two cache lines of the object): order application 1.5 -> ~1.2 us/unit.
- Order id loops in functions of their own (_actionCleanIds,
  _orderStampIds), warmed at tick 3 on packet-shaped input (JSON-parsed,
  packed small integers). The old warm-up used literal objects and holey
  arrays: the first real order deoptimized it ("wrong map") and a click's
  180k ids took ~30 ms; now ~2 ms first click, ~1 ms after.
- Movement kernels split into separately compiled passes (sim_parallel.js
  SIM_KERNEL_MOVE: _simMovePre (checks, holds, chases, looks),
  _simMoveFlow, _simMovePath, _simMoveEpilogue; SIM_KERNEL_MOVE_STEP:
  _simStepParked, _simStepFlow), units handed on in per-chunk lists
  (_simMoveLists). Why: the MOVE kernel was one 23 KB bytecode function;
  every code path first taken (the flow section had never run before the
  first click: four "insufficient type feedback" deopts at ticks 27-35)
  threw away its optimized code, and TurboFan took 50-110 ms to recompile
  it while the whole kernel ran ~10x slower on every helper. Replaying the
  dumped ticks 26-35 in order on one thread (.claude/kseq.cjs): MOVE ticks
  28/29/34/35 73/93/88/100 ms -> 8/28/26/26 (warm ~7); STEP 29/30
  31/38 -> 15/20. Outputs equal on every dumped tick (kbench VARIANT),
  steady cost within noise (a per-slot mode tested in six passes cost 2x:
  hence lists, and only three MOVE passes). Generated from the kernel's own
  text (scratchpad genmove/genstep: each pass declares exactly the arrays
  and per-unit locals it reads).
- Found: Node 22 runs V8 without Maglev (Chrome has it): --maglev changed
  little here (deopt recovery is the TurboFan recompile of big functions).

Runs (whole tick incl. actions + resync; this laptop drifted ~10-20%
slower during the session under background load (Firefox, Discord): judge
kernels by ratio to unchanged ones, or by replays):
- run 15 (streaming checksum, eff cap): mean 36.0, p50 34.7, p95 45.3,
  max 95; 5/200 over 50 (first click 95: processActions 41).
- run 16 (2 rounds, sanitize warm fix): mean 37.3, p95 44.7, max 78; 3/240
  over 50 (ticks 28, 29, 32: first round only; the warm round max 48.9).
- runs 18/19 (split kernels): cold MOVE spikes gone (tick 28 MOVE 12 -> 5-6
  ms) but the machine ran 8-20% slower overall (unchanged kernels SEPFIN,
  EFF, SP_COUNTS up by as much): 10 and 17 of 240 over 50.

Profiles (steady, host only: .claude/profpeer2.cjs): ~36 ms a tick, ~19 in
foreground kernels (main takes its share of chunks; ~3.8 waiting), the rest
many 0.3-1.3 ms serial parts (hash static, separation commit, eff stats,
combat scan posts, visibility sync, nav sweep). At tick 26 196k of 200k
units are parked (ON=2), at tick 150 157k flow and 43k parked. Single
thread per tick at tick 150: MOVE ~22 ms, STEP ~17, SEPFIN ~14 (~100 ns a
unit each: instructions and ~25 columns a unit, no one hot spot); MOVE's
flow look-ahead (simFlowLook/simNavStep/_simOpenBlock) ~25-30% of it,
mostly tile index <-> coordinate divisions.

Harness note: the guest runs every kernel serially on the same isolate as
the host (no helpers): its garbage (deoptimized kernels box doubles: MOVE
~15 MB in 4 click ticks) and GC land in the host's ticks. Main-isolate
scavenges cost 3-7 ms here (1.3 GB heap of two peers); in a browser each
peer has its own heap.

Tooling: tickbench RALLY_ROUNDS, TICKLOG=all, SUBPHASES (wrap any global
function), HEAPPROF_RANGE/OUT (+ .claude/heapsum.cjs, per script id);
.claude/kdump2.js (inputs of kernels at several ticks) + kseq.cjs (replay
them in order, VARIANT=, with --trace-deopt --allow-natives-syntax the
deopts land between tick markers); kalloc.cjs (bytes a kernel allocates);
kbench/kseq take NAME~tick; kdump(2) follow the _sim* functions a kernel
calls; profpeer2.cjs (one peer's samples of a tickbench profile).

Next: flow look-ahead arithmetic (coordinates carried, destination chunk
once per look), parked units' per-tick cost (an active set), order
application per unit, main-thread serial parts; then the other scenarios.

### 2026-10-03 (tenth round) — 100000-1000 rally benchmark, click spikes, tooling

Target (user): every main tick < 50 ms (most of the time) on 100000-1000
(200k units, ~43k buildings and mines) with both teams' combat units
selected (79k each) and 10 ctrl rally clicks 250 ms apart
(`DATA=tests/100000-1000.json HELPERS=7 RALLY10=all TOPPHASES=1 KTIME=1`).
Later (user): more demanding scenarios (fights, interspersed units and
towers, mazes / tower corridors, traps, player actions: tickbench ACTIONS).
User allows approximations/rounding (fair on average, no visible
artifacts), scaled-integer stats (x1000), big data-layout refactors.

Baseline: whole tick mean 50.5, p50 46.4, p95 83, max 193 (first click).

Fixed:
- Orders over 20000 units were truncated (ACTION_MAX_UNIT_IDS): queueAction
  splits move/attackMove/attack/attackBuilding/stop/hold into several
  actions (worker.js ACTION_SPLIT_BY_UNITS). The bench's first clicks
  ordered 20k of 79k before.
- Path regions (pathfinding.js): plain labels kept across portal changes;
  owners with portals derived from them (a pass, not a flood) and kept
  incrementally like the plain ones; a closed tile's split checked by a
  window search (PATH_REGION_LOCAL_RADIUS) before a full rebuild. A
  1M-tile flood (~65 ms) ran at orders after any building change.
  Tests: path-regions-incremental, path-regions-portals (new).
- Idle parked combat units all woke on one tick (+100 after the match
  start: 32k Unit.updates, ~60 ms): woken at their own phase, every 1000
  ticks (SIM_IDLE_PARK_TICKS; the kernel hands them back for anything).
- Drive-by area boxes (getAreaRangeTileBox) read the movement kernels'
  table (simMoveAreaBoxRead) instead of a BFS per (area, distance) on the
  main thread (~1 ms each after the first click).
- Order queue: typed ids (Float64Array), entries count their live units;
  an entry whose units were all ordered again is dropped at once (a
  click's 158k superseded ids were walked one by one: ~9 ms a tick).
  Sanitizing warmed at tick 3 (cold: ~4 ms per 20k ids, warm 0.4).
  Sanitized actions skip the second dedupe.
- towerTarget with a unit target: one lookup, not a units.find per tower.
- Barrack/spawner rally points: one setRallyMany action per point (with
  the buildings' tiles) instead of a setRally per building (a packet holds
  256 actions). tests/mixed-rally-move.test.cjs accepts it.
- Visibility safety sweeps 128/512 ticks, nav field sweep 128.
- STATUS pre-pass: status timers gated by a per-unit flag (stOn, set by
  the timers' accessors, a slot's start and a restore); the separation's
  tick-start copies only when the prebuilt separation is not taken.
  STATUS 2.7 -> 1.4 ms.
- Integer unit columns as Int32 (id, owner, commandState, attackFlash,
  status timers, workerTransferCooldown: whole numbers by construction).
- Unit index prebuild: the order merged from the last index
  (SIM_KERNEL_INDEX_MERGE: entries whose unit keeps its slot and chunk keep
  their order, the rest sorted and merged; ix.eid per entry tells a reused
  slot) instead of a 3-pass radix sort every tick (~40 ms serial of helper
  work). tests/index-merge.test.cjs (merged == sorted, every tick, deaths
  and spawns). This freed helpers and memory bandwidth: every foreground
  kernel got faster (MOVE 5.8 -> 4.5 ms, step 3.7 -> 2.8, finish 3.1 -> 2.6)
  and the steady game tick fell 36.6 -> 30.8 ms. The background lanes'
  load is the lever: the separation chain (~77 ms serial) and the hash
  region kernel (~21) next.

Run 11 (all of the above): whole tick mean 38.4, p50 37.3, p95 48.8, max
95 (first click); 5 of 200 ticks over 50 ms, all on click ticks (first
click: cold code in processActions 47 ms; MOVE / step / finish spikes the
ticks after).

Measured (whole tick, 200 ticks): mean 50.5 -> ~45-48, p95 83 -> ~58-69,
max 193 -> ~110-150 (first click, cold code). Run-to-run noise on this
laptop is ~3 ms in the mean; judge by several runs.

Found, not fixed:
- multiplayer-chaos-determinism with tiny order budgets
  (`CHAOS_SIM_EVAL="ORDER_UNITS_PER_PLAYER_TICK = 3; ORDER_UNITS_PER_TICK_ALL = 5; ORDER_UNITS_PER_ROUND = 2"`,
  CHAOS_MAPS=island) fails: repeated repairs after a forced divergence
  (pre-existing: fails on the previous session's staged code too). The
  default chaos run passes.
- Reading the MOVE kernel (sim_parallel.js ~494+) was blocked by the
  auto-mode classifier in this session: movement restructuring waits.

Tooling (.claude/): rsum.cjs (run summary), kdump.js + kbench.cjs (dump
any kernel's inputs on the guest at a tick and replay/time it standalone,
VARIANT=file to compare), sepdump/sepbench (pair stage), sepprobe (pair
counts), hashprobe (static hash timing), tickbench UPDTICK=a,b (Unit.update
by kind per tick), KTIMETICK (kernels per tick), DUMPBIN, ACTIONS=n
(player-action bursts: select all, ctrl rally points to enemy / random /
unreachable tiles, building rallies, unit and research queues, tower
targets, hold/stop/attack/attackBuilding), ACTIONS_TRAPS=n.
Findings: per-tick serial kernel work ~330 ms (8 cores x 50 ms is the
ceiling): separation chain ~92 (pairs 42-64, pack 21, finish 15, agg 12),
movement ~55, index prebuild ~43, hash region ~21; the per-unit passes are
memory-bound (15-30 Float64 columns per unit). Static hash part ~2.8 ms:
cold building objects (cache misses), not polymorphism. Kernel dispatch
overhead ~20-50 us.

### 2026-10-03 (ninth round) — desyncs with helpers, holds, rally benchmark

Desyncs (host with helpers vs a guest without), all found with the
tickbench desync probe (`EVAL="$(cat desyncprobe.js)"`, resync requests'
differing parts) and fixed:
1. Rally (75000-500, RALLY10=all: 112 desyncs): the end-of-tick index +
   separation prebuild read live state but ran lazily (at its wait) on a
   peer without helpers. Chains reading live state run eagerly there
   (`simParallelBackgroundChain(lane, stages, true)`), and their live
   stages finish before a tick's actions (`spatialIndexPrebuildSettle` in
   processActions).
2. ACTIVE/siege (36-38 desyncs): an invalidated prebuild left its
   separation half-taken: the prebuilt separation is now dropped on every
   invalidation (whether or not its chain still runs).
3. ACTIVE (still 36, first diff the tick after a between-tick teleport):
   lane 0 is shared by the separation chain and the state hash's region
   kernel; stage params persist, and the hash left P[5] = 1, which made the
   separation's pack read the live positions the unit pass was moving
   (the helpers mid-pass, the guest after it). Found with per-phase column
   hashes on both peers (tickbench `EVALALL=` / `AFTERALL=` / `AFTERALL_OUT=`,
   every peer). Every stage's params are now written whole (fill(0) first;
   also the index prebuild). Guard: `tests/lane-params-poison.test.cjs`
   (poisons idle lanes' params before each tick and hash: same hashes;
   fails at tick 0 without the fix).
   Results: ACTIVE, siege, RALLY10 all 0 desyncs / 0 patches; chaos with
   CHAOS_HOST_HELPERS=7 + thresholds passes.

Holds (siege unit pass 57 -> 51 ms): a stat change (effective level from
nearby counts, all the time in a battle) dropped every attack hold; holds
now stay when their range steps (mvReach) are the same and the unit still
deals damage (the chase step length follows the speed). A one-tick timer
is held too (the kernel's attack-tick hand-back, simHoldFire, fires it).
Probe of the in-range attackers still running Unit.update (siege): target
died 23%, stat-change release 19% (fixed), chasing with a path 17%, chase
13%, building approach 9%, forced targets 8%, 1-tick timers 7% (fixed).

More main-thread cuts (siege gameTick p50 133 -> ~107, steady ~102):
- Dead units' compaction: `Array.prototype.copyWithin` on the units array
  (objects: per element, ~20 ms a battle tick at 200k) replaced by a plain
  loop from the first removal (~1.5 ms); the typed slot map keeps
  copyWithin (a memmove).
- Kernel job sizes: MOVE/MOVE_STEP 4096 -> 1024 slots (SIM_MOVE_CHUNK; the
  last jobs' wait was ~3 ms), EFF_UNITS 1024 -> 256 (4 jobs of ~2.7 ms),
  STATUS 8192 -> 2048 with a per-job list of the units with events (the
  simulation thread visits those, not every unit of a job with one).
  MOVE wall 12.1 -> 9 ms, STATUS 4.2 -> 3, EFF 3.6 -> 2.1 (siege, 8 cores:
  per-job cost on the host is ~2x the serial one, all cores busy).
- State hash: the region sums in a typed accumulator (first-touch order and
  mod 2^32 sums as before: the same hashes) instead of a Map get/set per
  entity; the static slices iterated as arrays (remade when a slice changes).
- Damage alerts (presentation): a control group's membership by a set made
  once per list (a scan of a 50k-unit group per hit), groups marked this
  tick skipped, at most 40 map alerts a tick (the map keeps 40).
- Attack-move engagements that end (target dead, out of sight, leash,
  structure gone) resume the attack-move in the same update (doIdle did it
  a tick later: every kill sent each attacker through a whole idle update).
  Steady siege JS updates before: ~4.6k/tick (idle resumes 1.2k, attack-
  movers on paths 1k, held targets died 1.1k, forced 0.3k, chases 0.3k).

Rally benchmark (75000-500, 56k selected per team, 10 ctrl points 250 ms
apart, both teams): steady ticks 24-42 ms whole (gameTick p50 26.5);
click ticks 70-100 ms (orders applied 10k units a tick, ~2 us each, plus
the re-armed movers); the first click 195 ms (the units-by-id map was built
then: now built at the first tick). RALLYSTAT adds ~30 ms a tick to the
measured tick (its own loop): leave it off for timing. TOPPHASES no
longer wraps processActions twice.

Move orders: one target position and one flow path per order (never
changed in place, only replaced), ids deduplicated when queued, each
slice's units looked up in order (no set), the id sort skipped when in
order. (Click ticks unchanged within noise: the cost is the volume.)

Measured at the end (HELPERS=7, 0 desyncs / 0 patches everywhere):

| Workload | whole tick p50 | gameTick p50 (steady) | notes |
|---|---:|---:|---|
| ACTIVE 200k | 49.8 (p90 54) | 42 | move kernels 13, hash 6.6, unit pass 6.9, separation commit 5.9, eff 3.9, combat scan 3.1, worker search 2.6 |
| siege 200k + 16k towers | ~110 | ~100 (from ~115) | unit pass ~30 (4.6k JS updates/tick), move ~15, hits 8, status 6, adjacency 5, sep 5, towers 4, lasers 4; hash ~11 |
| RALLY10 75000-500 (150k) | 31.9 (steady 25-35) | 25 | click ticks 40-70 for ~2.5 s; first click 230-300 (lazy area boxes + path regions on the first big order of a match) |

Found by the regression suite and fixed: SIM_KERNEL_SEPARATION_YIELD had
been overwritten by the staggered SEP_MARK loop in the eighth round
(ReferenceError on `meta`: only the in-tick slot fallback,
_prepareSharedUnitSeparation, runs it); the order queue now also takes
actions without a sanitized id set (tests call processAction directly);
tests/shared-separation-commit.test.cjs updated to the current FINISH
(exception lists, gain/now params, sums cleared as read, positions
committed to the columns).

Separation quality unchanged (separation-jitter: 0 visible jitter, ~5%
friend overlap, 0 enemy overlap). Tests: chaos (plain and with
CHAOS_HOST_HELPERS=7 + thresholds), desync-recovery, snapshot, patch,
lane-params-poison, kernel-object-equivalence (seeds 5/7/9/3/11/21).

Next (largest first): siege unit pass (retargeting after kills and chases
with paths in the kernels: each costs a whole Unit.update), hits resolve
(8 ms: per-hit JS), MOVE kernel holds (per-tick revalidation of held units:
~half the kernel; cache the range result by positions + versions), hash
static/reservations part (~4 ms in ACTIVE), separation FINISH over every
slot (2.7 ms), building-change handlers in sieges (adjacency, lasers).

Noted, not fixed: kernel-object equivalence seed 13 crossroads (audit #2);
with SEPARATION_SLOT_MIN_UNITS/SPATIAL_PARALLEL_MIN_UNITS = 0 on every peer
and the hash/eff kernels on the host only, the object-path guest needs
repairs (seed 5 islands, 37; pre-existing, first diff includes A* budget
and _sepMoved): to bisect.

### 2026-10-02 (eighth round) — separation chain, index prebuild, total-work cuts

User priorities (restated): main tick < 50 ms at 20 TPS; smooth jitter-free
movement/turning of units and buildings; responsive commands; units not
packed too close, a gap between teams; everything else free to rework.

Key finding: the harness guest runs every kernel serially, so its profile
is the total CPU work per tick: ~490 ms at 200k in ACTIVE (8 cores x 50 ms
is the ceiling). Work must shrink, not only move to helpers. Profile per
peer with `.claude/profpeer.cjs file.cpuprofile [self] [total] [root]`
(script ids split host and guest); kernel names for profile lines:
`.claude/kname.cjs "" <line>...`.

Done:
1. Restore duplicate slots (the reported healer-candidate mismatch): the
   fix in HEAD (simUnitStateCollect before simUnitStateCompact in
   snapDecodeState) holds; chaos/patch/desync/snapshot pass in both modes.
2. Background lanes: chains of up to 12 stages (simParallelBackgroundChain,
   per-stage params simParallelStageParams; the participant finishing a
   stage's last chunk opens the next). Per-lane id + reader count: a lane is
   rewritten only closed and empty (fixes DETERMINISM_AUDIT #1, a late claim
   running a chunk of the next job). 7 lanes (SIM_LANE_IX new), ctl 128
   words. tests/background-chain.test.cjs (real threads, 0/1/7 helpers).
3. Separation as a helper chain on lane 0 (PACK -> AGG -> MARK -> PAIRS even
   bands -> PAIRS odd bands), from a tick-start copy (STATUS writes
   x0/y0, sepD0/sepR0/sepL0), during the unit pass. Each touching pair once
   (both sides' pushes; integer sums, so order-free; bands of >= reach rows,
   two stages, no atomics); records Float32 (x, y, r) + packed meta.
   Staggered: a unit takes part on (t + id) even ticks; FINISH spreads each
   push over two ticks (sepCx/sepCy carry, reset at a resync) with gain
   1.2; FINISH indexes tile changes itself (the main thread lists only
   blocked/retry units); one SP_COUNTS pass a tick. Global every-other-tick
   (UNIT_SEPARATION_MODE 2) made crowds sway (reversals 2x): not used.
   tests/separation-pairs.test.cjs (pair kernel == per-unit kernel, bit
   exact), tests/separation-jitter.test.cjs (overlap, back-and-forth,
   largest tick move vs every-tick separation).
4. Area index removed (its one reader, forEachUnitInAreaRange, walks the
   areas' tiles: tile order, then units order).
5. Unit index prebuilt after each tick on SIM_LANE_IX (chunk.js
   spatialIndexPrebuild): KEYS, radix (HIST/PREFIX/SCATTER x3), FILL, RUNS
   as a chain while the state hash runs; taken at the next use; dropped
   when the units list changed (slot map ver), a unit died outside a tick
   (dead setter) or a restore/flush invalidated it.
6. Hash: units' list order in the region kernel (position-keyed sum);
   object fields of each unit every 400 ticks (SNAP_HASH_OBJ_GROUPS 40).
7. Adjacency recalculation: only at the tick's end (mid-tick requests
   wait), touched areas only (no copy of all 120k areas' flags).
8. Visibility safety sweeps: buildings over 64 ticks, units over 256.
9. Research: units take new stat tables lazily at their effective-stats
   refresh (per (owner, type) table versions, esVer column; the behind flag
   travels in snapshots as _statsBehind); no all-units refresh (a research
   cost ~1 s of unit pass at 200k). Buildings: the floor items list instead
   of two scans of every grid cell (still immediate).

Measured (ACTIVE 200k, HELPERS=7, idle machine): gameTick p50 ~140 (last
session) -> 50.2 ms; whole tick p50 72 -> 65 ms. resyncAfterTick 18 -> 10.
Remaining gameTick (mean ms): simMoveRun 13.4 (MOVE 5.6, MOVE_STEP 3.3,
drive-by 1.5), unit pass 9.8, eff stats ~5-8, separation commit 6.4
(FINISH 3, counts 1.5, chain wait), status 2.5, vis 2.1.
Movement probe (per tick): 173k plain steps, 18.6k steers (14k tile
entries, 4.5k window ends), 25k parked, ~600 hand-backs.

Determinism to fix later (noted, not fixed): kernel/object chase divergence
(DETERMINISM_AUDIT #2), audit #3-#6; hash detection of object-only fields
now 400 ticks; visibility sweeps rely on complete hooks over 256 ticks;
index prebuild relies on no positions being set outside ticks except via
restore; building research still immediate (a spike for big tower counts).

Next: movement kernels (motion records with a validity deadline so most
units only integrate; steering ahead on a tier), effective stats off the
tick (output buffers, commit next tick), STATUS sparse, hash JS parts
(building core, reservations), worker check ticks (WORKER_MOVE_CHECK_TICKS).

### 2026-10-02 (seventh round) — tier lanes, combat on the movers, determinism

User direction (plan, "Sixth refinement"): the 20 TPS thread only does what
players perceive at that rate and must stay well under 50 ms; everything
else on a hierarchy of lower-rate tier threads (10/5/1/0.5 TPS) committing
at fixed, staggered ticks; cadences deterministic, later handshaked and
auto-adjusted in multiplayer, editable in the menu.

Done (siege, HELPERS=7, machine ~60% loaded by other work):
1. Long-range attack holds (mvHWin / mvHTT / mvHVer: window key, target
   tile, area layout version; _simAreaLayoutVer bumps with a new layout).
2. Drive-by looks: the kernel hands a ready shooter back only when
   _simDriveByAny finds a visible enemy in range (unit index, exact
   _simUnitInAttackRange with mvRangeK = floor range) or a visible hostile
   structure in area range. c1 updates 3.4k -> 0.6k a tick.
3. Building attackers' 8-tick look for units from the combat scan
   (_combatScanHit; the scan covers mvOn 5/6 automatic targets on their look
   tick); the approach/hold kernels continue when it found none. c3:bld
   1.8k -> 0.6k.
4. Attack-move structure look counts only visible tiles.
5. Hold <-> chase in the kernel: a hold whose target stepped out of range
   takes the chase step (outputs 11/12), a chase come in range is held
   (13); simHoldChaseCommit does the rest of Unit.update at its turn.
6. Tier lanes in sim_parallel.js (SIM_LANE_T10/T5/T1/T05, priority order
   SIM_PAR_BG_ORDER, per-lane params); sim_parallel version bumped
   (20261013-a) for the helpers.
7. Visibility units' cover as a T5 tier (snapshot, seeds, per-player
   spread with the diff, commit at phase 1): 12.1 -> 8.7 ms.
8. Units' damage over time reported every 4 ticks summed (stAcc; reset on
   every peer at a flush): status pre-pass 14 -> 8.7 ms.
9. Buildings tick statuses only while something runs (_thingStatusSelf):
   towers 36 -> 21 ms.
10. Projectile structure ranking cached by towersVersion (new) /
    barracksVersion / collectorSpawnersVersion.
11. Stat cadences: UNIT_EFFECTIVE_STATS_RECALC_TICKS 20 (was 5),
    THING_STATS_RECALC_INTERVAL_SECONDS 10 (was 3); menu defaults match.

Determinism fixes (chaos test, arena, repair of guest1 at tick 295):
- Flow look-ahead cache keyed by the field kind (1 narrow / 2 wide), not
  the field slot generation (peer-local allocation history).
- Field remakes over a new build all at the next flush (the slot-order
  spreading made field contents depend on each peer's pool).
- simMoveStatsChanged disarms only when the movement stats changed; a
  refresh's level-then-effective scaling notifies once at the end
  (_unitStatsNotifyHeld).
- Visibility tier steps by tick only; a reset recompute is followed by the
  tick's normal step.
Debugging note: CHAOS_SIM_EVAL runs the world to a safe tick and changes
the harness schedule; inject instrumentation at setup instead.

Later the same day (user: every search, range check and scan on the
helpers; the tick O(1) per entity):
12. Acquisition tier (T10 lane, period 4, phases 2/0): unit and structure
    targets from a snapshot; O(1) reads; no fallback searches.
13. Laser beam map + SIM_KERNEL_LASER_HITS; towers 21 -> 9 ms.
14. SIM_KERNEL_DRIVEBY (exact answers, O(1) check in _driveByScan).
15. Chase by flow; pass-start death semantics (dead0, _unitTickDead);
    held units not visited; candidates by SIM_KERNEL_UPD_CAND; post lists
    from the movement kernel.
16. Building order by list version; projectile structure order by kind
    and tile.
17. Determinism: building statuses in the per-slice core hash; status
    sets rebuilt at decode end; effective levels marked applied at flush.
Siege p50 252 ms (tick p50 ~236); unit pass p50 ~60.
r31 (all, machine loaded): base p50 145 (tick 132), active 213 (tick 185),
siege 260 (tick 239). Active is now led by workers' searches (healers
40 ms / 150 calls, salvagers 29 ms / 3 calls, collectors 19, builders 16).
Full suite: all pass but flat-gpu-renderer (fails at HEAD too) and
render-frame-stability (browser timing, passes alone). Tests updated for
the new rules: structure looks read the tier (performance-regressions),
traps rank by distance (structure-targeting), extracted sources end with
a newline (battle-performance).

Worker AI off the tick (2026-10-02, user: worker AI on helper tiers, the
tick O(1)):
18. Worker search tier (worker.js, SIM_KERNEL_WS_SCAN, lane T1, post at
    phase 3, commit 2 ticks later): a worker due to search posts a request
    and waits idle until the commit; the kernel returns its K=6 best sites;
    the take re-checks them live (validity, exclusivity) and picks the
    first. Collectors: persistent per-type site groups (drops, mines,
    farms, spawners; rebuilt on list versions or construction done).
    Builders, healers (queues), salvagers, researchers: the work site grid
    (per tile: work bits from pure tests, owner, area; per 8x8 counts; per
    owner counts) kept by the tile journal, dirty tiles (salvage marks,
    construction done, queue changes, effective level changes) and a
    60-tick sweep; changed only between searches (phases 1-3). Both kinds
    skip sites reserved by another worker of the type (an all-type
    reservation mirror per tile, from workerReservedSet) and apply the
    area-step limit in the kernel (CSR BFS from the origin's window).
19. Healer candidates (12 most damaged per owner) on lane T05: columns
    copied at the round's first tick (maxE: a new mirror column written
    where unit stats are applied; live), merged at its last; 3.6 -> 0.3 ms.
20. Worker conflict index kept between ticks (extended by
    _setWorkerTarget, compacted from its own entries), not rebuilt from
    all units each tick: 4 -> 0.2 ms. Closest spawner: the owner's list of
    the type, linear under 512.
21. Fix (latent, exposed by the tier): a parked idle worker in a search
    backoff was not woken at the backoff's end, where the object path's
    scheduled search runs (simMoveTryPark: sched = max(next, failUntil)).
ACTIVE p50 211 -> 165 ms (workers' AI 47 -> ~13 ms a tick, mostly the
per-worker state machines and idle wakes). Equivalence (8 seeds), chaos,
desync, corruption fuzz and the worker tests pass.

simMoveRun (2026-10-02, user: under 10 ms; tricks and approximations fine
when movement stays smooth). ACTIVE 200k: 29 -> ~16 ms (p50 tick ~144-155;
machine timing varies +-10% run to run, compare within runs):
22. Kernel-side index update: the movement kernel's epilogue writes tile,
    area and chunk key of units that changed tile (spatialSlotMove's) and
    keeps the chunk move; SIM_KERNEL_SP_COUNTS applies the count moves with
    Atomics at the pass's end (counts verified equal to a full recount).
    Node-step charges summed per chunk/owner/type in the kernel.
23. Unit slot compaction after a whole-world restore (match start applied
    the host's own snapshot: 400k slots for 200k units).
24. Flow movement steers only on tile entry, without a commitment, or when
    its window ends (16 ticks; 4 within 8 tiles of the destination);
    between, it follows the committed step (mvCD/mvCTl/mvCT/mvCN/mvCVx/y),
    in the kernel and Unit._followNavNode alike (equivalence holds).
    SIM_KERNEL_MOVE_STEP: the plain integrate and parked ticks in a small
    kernel before the movement kernel (bit-identical results).
25. Latent mismatches fixed: _simMoveTryFlowArm vs continueUnitRoute (a
    used-up path ending at the route's end); the integrator placed after
    the field checks (a remade field hands back so Unit.update asks again).
26. Hostile tables in two parallel passes (bit-identical); acquisition
    tier reads the live index (waited at the next index rebuild), copies
    only the structure tables and cover; drive-by checks use the timer and
    the drive-by kernel's verdict before the area box; area boxes ensured
    only when missing; wall key from per-block 3x3 sums (one read).
Measured: a foreground parallel job costs 27-63 us fixed (fusing saves
little). Main-kernel steering ~1 us per unit (sparse rows, many columns);
look-ahead rebuilds on tile entry ~35-40% of it. Ideas left: per field and
tile look-ahead memo (Atomics-published), drive-by superset box before the
area box, fewer columns per step.

Remaining (siege, mean ms): unit pass ~90-115 (~7.4k Unit.update a tick:
idle 1.4k, attackers not armed 1.75k, attack-move acquisitions 1k, kernel
hand-backs for dead targets / non-direct chases ~1.9k), simMoveRun ~46-51,
towers 21, hits 16, hash 16, orders 14 (bursty), index 9.7, building order
9, visibility 8.7, stats 8.8 + 7.6 (before the cadence change).


### 2026-10-01 (sixth round) — one tick path: separation job, visibility recompute, workers

User direction (see the plan, "Fifth refinement"): the tick path is one
parallel path (move, turn, commit), O(1) per entity; every decision,
search, reroute and transfer runs in background layers at fixed cadences;
no pathfinding of any kind on the tick path; approximations of a few ticks
are fine when rates hold on average; moving eventually beats never moving.

1. Separation contacts are a lane-0 background job (`separationStart`
   after the status pre-pass, from tick-start positions; prepare marks
   movers by the `sepMov` column written by the finish kernel);
   `runUnitSeparationPass` waits and commits. Background jobs have two
   lanes (0 same-tick, 1 long: navigation builds).
2. The unit pass walks an activity list: candidates (no kernel output, or
   held/chasing) listed in index order, each 64-unit block's run walked as
   a rotation from its start step (identical order, checked against the
   old walk on random inputs).
3. Visibility: units' coverage is recomputed every tick at
   `syncVisibilityCoverage`: `SIM_KERNEL_VIS_SEED` (28, replaces
   VIS_HELD) marks each unit's window areas with its steps (atomic max,
   stamped), then per player a bucket spread over the area graph; the
   difference from last tick counts once per area in `cover` (buildings
   keep their incremental ring counts). Unit hooks only keep the unit's
   parameters (vsGen/vsR/vsP1/vsP2/vsA columns). Removed: the unit-phase
   hold for units, `visCoverSlotWindow` work, window zones (spZone,
   mvZmask, zone kernel outputs 2/8), vsList/vsHeld columns. Measured on
   the 1000 map: 5.4k seed areas per player, ~6k covered, 120k areas.
4. Workers: (a) while the transfer cooldown runs `updateWorkerAI` does
   nothing (player moves excepted) and a standing worker is parked until
   it ends (`simMoveTryParkWork`); walking workers skip check-tick
   hand-backs meanwhile. (b) `WORKER_MOVE_CHECK_TICKS` 8 -> 32. (c)
   Workers on A* paths are armed in path mode (window ends before a tile
   the worker may not stand on; check ticks in path mode). (d) Routing is
   flow navigation only: `_requestWorkerPath` = `navPathTo`, spawner
   routes = nearest spawner + `navPathTo` (no geometric fallback, no
   route cache, no A* or budget fallbacks; manual-move rebuilds and
   blocked-assign moves use nav). (e) On an unreachable flow a worker
   stands (kernel and `_followNavNode`) instead of "arriving" and
   rerouting every tick (the probe found ~100k such AI runs in 3 s of
   ACTIVE: approach tile 4+ away, flow step none). (f) The spawner type
   index is rebuilt only when `collectorSpawnersVersion` changes; the
   salvage-mark lists when marks or tile entities change (both reset on
   every peer at a resync).
5. Flow detour: a flow step into a wall the navigation predates (a building
   since its last build) goes to the open side neighbour nearest the tile
   the flow leads to past it (`simNavDetour`, kernel and
   `_followNavNode`). Before, ~8k combat units and ~2.6k workers a tick
   were handed back for this in ACTIVE. Walled in on all four sides: it
   stands (kernel too). A flow step into a wall slides along it (x, else
   y, else stands: `simFlowSlide`, both paths), so flow movers never need
   the serial push-out (which searched and dropped the path).
6. Unreachable flows: a worker more than a tile from its destination
   stands (within a tile it has arrived: a builder inside its own site);
   others arrive as before.
7. Idle workers: the periodic search is every 1.5 s (was 0.5 s); a parked
   idle worker pushed off its tile is no longer woken (the version hash is
   computed where it stands; an origin that is the worker itself is now
   the unit object, `wkTwice` 0, and follows it; `wkTile` removed).
   Idle combat units' safety wake every 100 ticks (was 20; the kernel
   watches their aggro box every tick).
8. Searches: salvagers look at marked structures in their search box only
   (buckets) and no longer build a Set of every spawner per search
   (`_collectorSpawnerSet`, by membership version); the owned queue
   spawners index follows `barracksVersion`/`collectorSpawnersVersion`.
9. Building layer: statuses of buildings and floor items run only for an
   active set (`thingStatusWake` from status effects and damage, plus a
   sweep of a TICK_RATE-th of the items a tick with their upkeep share;
   made anew on every peer at a resync); thing stats refresh from phase
   buckets kept from the tile entity journal (due bucket + new things, in
   tile order) instead of a walk over every building; quiet barracks and
   spawners (nothing queued, timer at rest, no status; not research) skip
   their update.
10. Hashing: the per-slice building/floor item/mine lists are kept per tile
    from the tile entity journal (were rebuilt on every tile index change,
    ~13 ms a tick in ACTIVE). The region kernel sums the slice's units into
    a typed per-region accumulator (atomics; touched regions listed once),
    so the simulation thread no longer walks every unit or does a Map
    update per unit (`SNAP_HASH_KERNEL_SUMS`, tests compare both ways:
    equal). Rotations (user: hashing must not take a large share of the
    tick; next is moving it off the tick entirely): units' object fields
    one group by id in `SNAP_HASH_OBJ_GROUPS` = 10 (each unit every 100
    ticks; columns still every slice), grid rows, areas and the slice's
    building hashes one round in `SNAP_HASH_GRID_ROUNDS` = 10 (every 100
    ticks), list order sliced by position for every list. Chaos, desync
    recovery and corruption fuzz pass with forced kernel paths. Base hash
    23.5 -> 14.5 ms (before the building rotation).

Measured: base p50 290 -> 223 ms (gameTick mean 292 -> 200: separation
53 -> 17, simMoveRun 59 -> 34, visibility 35 -> 12, unit pass 32 -> 25);
ACTIVE p50 430 -> 377 ms (unit pass 171 -> 111). Remaining ACTIVE worker
AI (profile, 64 ms a tick per peer): searches (healer queues 25%,
collectors 19%, builders 18%, researchers 10%, salvagers 9%), spawner
lookups, a gather ~0.9 ms each.

### 2026-10-01 (fourth round) — siege diagnosis, shrines

Suite on the third round: 69/72 in both modes; the 3 failures were test
sandboxes missing `simSharedArray`/`simParallelBind` (collector-farms,
structure-targeting, worker-target-index), fixed in the tests.

Siege diagnosis (`TOWERS=8000 BATTLE=mix`; new tickbench tools `WAKESTAT=1`
why idle workers ran Unit.update, `AMSTAT=1` attack-move/idle hand-backs by
scan answer and outcome, `EVAL=<code>` ad-hoc host instrumentation):

- Idle workers were the largest unit-pass item (~190 ms/tick with the
  wrapper): almost all `woke:wakeVer`, i.e. their periodic search tick came
  and the work version had changed. Cause: ~330 unit deaths per tick each
  dropped a bounty item, and every drop bumped the '*' work version of all
  8 players in its 64-tile region, so every idle worker type near a battle
  searched (collector searches ~150 us: the per-tick conflict index rebuild
  `_getWorkersWithTargetThisTick` and conflict checks, plan A4).
- Attack-move: `c2 ... :st->2` 4924 calls/tick (~92 ms): on the structure
  tick the kernel handed back whenever an 8x8 block in reach held a
  hostile structure; `_findAutoStructureTarget` then found nothing.

Changes:

1. Drops bump only the drop-collecting worker types (`workerWorkDropAdded`).
2. Movement kernel: on attack-move/idle-park structure ticks, after the
   block test, a tile-exact conservative test (`_simHostileStructNear`: any
   tile with a hostile `mv.struct` code whose rectangle comes within aggro
   range `cbRange`) before handing back. Equivalence test passes (default
   cases); not yet benchmarked.
3. Shrines (gameplay change requested by the user, menu Resources
   "💀 Shrines", default on; off = the old bounty drops): damage taken by a
   player's units and buildings (energy actually lost, never below 0) goes
   to the player's shrine `player.shrine` (💀). Hook `shrineDamageTaken`
   beside every simulation `recordDamageVisual` (projectiles, splash,
   lasers, unit hits, mines, status DOT incl. the kernel's, ram recoil).
   Summed per tick as fixed-point integers (`_shrinePendingFixed`), so the
   order of damage does not matter; `shrineTick` (end of gameTick) adds it
   and drains up to `drainRate / TICK_RATE` into energy/★ times
   `multiplier` per the player's `shrineDrain` order (1 ⚡, 2 ★, 3 half
   each, 0 none). Stats: building `shrine` (`notBuildable`, research only:
   multiplier ×1.25/level like farms, drainRate ×2/level). UI: bottom-left
   stack ⚡/★/💀 with per-second rates and 💀 drain toggles, Pop below;
   graph metric; ⚡/s and ★/s panel rows; bottom bar. With shrines on no
   bounty drops exist, so the drop-wake cost is gone.
   `tests/shrine.test.cjs` (both modes): hook, overkill, drain math, order,
   peer agreement, exact hashes. Test sandboxes that stub
   `recordDamageVisual` also stub `shrineDamageTaken`.
4. Building hold (mvOn 5, `_simMoveTryHoldBuilding`): a unit attacking a
   structure in range while its cooldown runs stays in the kernel (tile
   still hostile in `mv.struct`, area in sight, `_simInAreaRange` with
   k <= 2, timer above 0); handed back on its attack tick and, for
   automatic targets, on the `(t + id) % 8` look for enemy units. Output 6
   like the unit hold; `simHoldStillValid` re-checks the structure object at
   the unit's turn (alive, still the target, same tile). Equivalence test
   passes (hold counts rose on crossroads).

Shrine follow-ups (user requests): 💀 is a per-player resource (no map
object): research multiplier 0.01 x 2^level, drain 1 x 10^level per second
(`RESEARCH_FORMULA_CONFIG.shrine*BonusExp`, per-key research exponents via
`getResearchBonusExpForStat(kind, stat, key)`); stat matrices and the level
dropdown show research levels only for level-less things
(`researchMatrixThingLevels`); gains carry fractions between ticks
(`player.shrineCarry`, state) so small multipliers pay out exactly.

### 2026-10-01 (fifth round) — kernels for the siege, background jobs, crowds

The user's direction (recorded here for later sessions): the per-tick main
path must become O(1)-ish per active entity; background work committed at
fixed tick delays (like the navigation build) with O(1) lookups and
reservation in the tick; deterministic approximations are fine (fair,
reversible, with fallbacks: units must never get stuck for good). Goal
first: stable 20 TPS (< 50 ms per tick); tighten approximations afterwards.

5. Fire commit (kernel output 10): a held unit's attack tick (unit or
   structure target) is committed at its turn by `simHoldFire` (attack,
   re-arm) instead of a full `Unit.update`.
6. Approach (mvOn 6, `_simMoveTryApproachBuilding`): a unit walking its
   path (or a nav node's flow field, crowd rule as `_followNavNode`) to a
   structure it attacks stays in the kernel while the structure's tile is
   still hostile, in sight and out of range; hands back on the 8-tick look
   for units. Siege building-attacker updates 9.5k -> 2k per tick.
7. Chase with a path of its own arms the kernel's chase mode (flag 1: then
   flying is no reason to step straight). Chase updates 12.7k -> 4.6k.
8. Combat scan: a per-tile owner mask (`SIM_KERNEL_TILE_OWNERS`, `ix.omask`)
   lets scans pass over tiles with no enemy (results unchanged).
9. Background jobs (`simParallelBackground` / `simParallelBackgroundWait`,
   sim_parallel.js): helpers take a job's chunks whenever no foreground job
   waits; the simulation thread only at the wait. Ticket counter (job id <<
   24 | chunk) so no chunk is lost or run twice across jobs; own parameter
   block `_simBgParams`. The navigation rebuild's local fields and hop
   table run this way (collected at the build's fixed steps);
   `tests/nav-background.test.cjs` compares with a synchronous build (0
   and 3 real helpers).
10. Healer candidate changes bump the healer work versions of the regions
    the candidates are in (not a global generation): idle healers far from
    any change stay parked. Siege healer wakes 1.8k -> 0.7k per tick.
11. Crowds (approximation): a moving unit within 64 tiles of a group's
    destination, held back (under 30% of its speed made good) beside an
    idle or waiting unit of its own, waits (`_navLastD = -2 - dest`, the
    snapshotted column): still, a look every 16 ticks (on when fewer than 9
    units are listed in its 3x3 tiles) and a try every 64 (a corridor jam
    clears). Within 8 tiles: arrived as before. Crowd flag and density come
    from the combat scan (tick start; columns `cwNear`, `cwDense`,
    `cwTick`), so the kernel and `Unit.update` decide alike.

Measured (siege p50): 628 -> 571 (round 4) -> 517 (approach, fire) -> 509
(owner mask) -> 499 (background nav) -> 490 (chase with path). Base ~285-290
(unchanged): the base workload is 157k units marching across the map (most
over 128 tiles from their rally points), so its cost is moving units:
movement kernel, separation (~140k contacts and ~135k pushed units a tick),
tile/zone/visibility updates for movers, the index.

Tools: tickbench `EVAL=<code>` (host, before the run); equivalence test
`DIFFU=1` (unit fields first) and `PU` with `HOST_SIM_EVAL` prints
`globalThis.__hostStat`.

### 2026-10-01 — determinism repair

Fixed (all found with the equivalence harness, now `tests/kernel-object-equivalence.test.cjs`):

1. `_findNearbyCombatEnemy`, drive-by scan, `doHolding`, mine blast: other
   units' live positions → tick-start positions.
2. `_findClosestEnemyUnitByChunks`: removed peer-local query cache (cleared
   only on the restoring guest); now a pure nearest-then-lowest-id search at
   tick-start positions, matching the combat scan kernel.
3. Healer targeting / range / work-site memory: tick-start positions of unit
   targets.
4. Spatial chunk/block counts deferred to the end of the unit pass.
5. `_floorTile` backed by the kernel's `mvFloor` column; the kernel records
   every checked tile (was stale on kernel-moved units).
6. `_astarLastCharged*` (same-tick dedupe only) no longer snapshotted.
7. Builder stuck watchdog on a fixed 16-tick cadence.
8. Flow-mode arming ignored a unit's own non-route path (stale `_routeKey`).
9. `tests/multiplayer-patch.test.cjs`: race where the guest ran the restore
   tick before the host encoded the snapshot (it silently skipped the
   restore, hiding item 5).
10. Worker mode (`SIM_WORKER=1`), pre-existing at HEAD: the host page
    watches selected units, so the host's simulation built their display
    path each tick; `navPath` requested (allocated and built) a destination
    field on the host only, changing field readiness for later simulation
    requests (chaos solar_system diverged at tick 329). `navPath` is now
    read-only (existing fields or coarse steps; never builds anything).
11. `tests/run-regressions.cjs`: per-file timeout 900 s (mode 0) / 1800 s
    (mode 1; big multiplayer files take 10-16 min there), `--timeout=s`.

Status: equivalence clean on 40+ seed/map runs; determinism suite: see
latest run below.

### 2026-10-01 — first optimization slices (stage 1 measurements → fixes)

Profiled ACTIVE=1 (ticks 100-120 and 140-160, `.claude/profsum.cjs`):

1. Laser links (plan K1): `recalculateLaserConnections` was O(towers^2)
   and ran on every tower destroyed (salvage bursts: ~460 ms/tick). Now
   indexed by owner+row/column (partners in towers-array order, exactly as
   before; `tests/laser-links.test.cjs` checks against the all-pairs
   reference), and deferred: placement/destroy mark it dirty, flushed in a
   laser's update and at the end of `gameTick` (before hashing); restores
   still recompute at once.
2. Salvager search: the per-tick salvage-mark cache now also keeps each
   owner's marked towers/barracks/spawners in array order; searches walk
   those instead of every structure (live re-check: still marked, still its
   tile's entity). Mark orders invalidate the cache (`salvageMarksChanged`).
3. Idle-worker parking: after a failed search the backoff left
   `_workerNextIdleRetargetTick` in the past, so `simMoveTryPark` refused
   to park: ~2/3 of idle workers ran `Unit.update` every tick. The
   scheduled search now moves on during the backoff (changes are seen on
   the next staggered or scheduled search tick; the park wakes for both).
   `.claude/parkprobe.cjs` reports why idle workers are not parked.

Results (see Measurements): base 374 → 317 ms p50 (unit pass 123 → 33),
active 560 → 529 (mean 703 → 578, max 4298 → 1446), battle 740 → 650.

4. Projectiles (plan J2): a shot looked at every tower/barrack/spawner each
   tick. Now `projectilesBegin` ranks the structures once per projectile
   phase (towers, barracks, spawners in array order) and a shot checks the
   tile entities around it, taking the lowest rank: the same structure as
   the list scan (checked on 40k random points in chaos worlds). Spent
   shots are compacted in one pass (order kept) instead of `splice`.
   Battle 650 → 526 ms p50 (max 2503 → 1316).
5. Builder search: per structure bucket and tick, the structures that are
   builder work the first time the bucket is looked at
   (`_builderBucketWork`; that look starts due upgrades, as the predicate
   always did); searches re-check only those. Battle idle workers 200 → 124
   ms/tick; battle 495 ms, active 505 ms p50.
6. Salvager search: distance and "nearer than the best" before the
   exclusivity check (pure apart from clearing dead units' reservations).

Open notes: `_isBuilderWorkTarget` still has the upgrade side effect (plan
A3: make eligibility pure, activation an explicit intent).

### 2026-10-01 (continued) — combat kernels and hashing

7. Combat scan before the movement kernel (inside `simMoveRun`); the
   kernel keeps aggro units (attack-move, parked idle) moving when the scan
   found no enemy unit, handing back only on their structure-check tick
   (`(t + id) & 3 == 0`) when hostile structures may be in reach (new
   structures-only summed-area table `mv.hstruct`). Battle attack-move
   updates 26070 → 1688 per tick.
8. Chase mode (mvOn 4, `simMoveTryChase`): an attacker after an enemy unit
   out of range, with no path of its own, steps straight at it in the
   kernel exactly as `doAttacking` (sight, range, leash, `_isChaseStepOpen`,
   never into a wall tile; outputs 7/8/9), re-checked at its turn
   (`simChaseStillValid`, undone otherwise). Chase updates 21.5k → 13.8k
   per tick; the rest have paths (see next steps).
   `tests/kernel-object-equivalence.test.cjs` now reports kernel unit-ticks
   by mode (chase/hold/move) so coverage is visible.
9. Hashing (plan H1, partial; 44.8 → 24 ms/tick at 200k units, measured
   with tickbench `AFTER=`): area state hashed by slice (was all 120k areas
   every tick); reservation regions skipped by exact per-region counts
   (every write goes through `workerReservedSet`; decode invalidates);
   status columns hashed by the kernel; unit object fields hashed for a
   third of the slice's units per rotation (by id), all fields at once, so
   each unit's object fields are checked every 30 ticks, columns every 10.
   `SNAP_HASH_KERNEL_MIN_UNITS` (8192) can be lowered by tests:
   `SNAP_KERNEL_MIN=0 node tests/multiplayer-corruption-fuzz.test.cjs`
   covers the large-world hash path (passes).

10. Latent desync (found while planning path-chase): the movement kernel
    charges A* step costs in units order before the pass, `Unit.update` in
    the pass's order, and a step not covered by what is left marks the
    unit (`_astarBudgetRetryTick`, which delays its path retries). When a
    player's A* ran low the marks differed between a restored peer and the
    rest. Now, during the pass, coverage is judged against the budget at
    the pass's start (`astarPassStart`), the same for every step. The
    equivalence test has a low-A* case (`seed:map:astar`, default
    `9:crossroads:300`); with the old rule it diverges within 40 ticks.

Tools: tickbench `CHASESTAT=1`, `AFTER=<expr>` (timed micro-measurements
in the loaded world), idle workers split by type in `upd`; profsum takes
a subtree function name.

Results after items 7-10 (100000-1000, HELPERS=7; run-to-run noise is
roughly +-10 ms): base 312 ms p50 (resync 44 → 25), active 493,
battle 445 (from 497). Determinism + gameplay suite 68/68 in both modes.

Load-sensitive tests (pass alone, can fail when 4+ heavy tests run at
once): `render-frame-stability` (frame-hold counts),
`shared-kernel-threads` (made tolerant: helpers must claim work in some
run, not every run).

### 2026-10-01 (third round) — serial main-thread work into kernels

Measured (tickbench `AFTER=` micro-timings, TOPPHASES now covers most of
`gameTick`): in base, ~180 ms of the tick was serial main-thread work around
the kernels. Done:

11. Unit index (spatial index rebuild 33 → 11 ms): the parallel build lists
    units by slot (`_sxESlot`, `_sxASlot`; the unit is `owners[slot]`,
    `_sxOwners()`), ranges, counts and per-area owner counts written by
    kernels (SIM_KERNEL_INDEX_FILL / INDEX_RUNS) instead of two serial
    passes placing objects. Slots freed in a tick are reused only from the
    next rebuild (`simUnitStateReleaseFreed`), so entries stay valid all
    tick. `tests/spatial-index-builds.test.cjs` checks serial = parallel
    answers for every query kind.
12. Unit effective stats (27-33 → 7-8 ms): `stackCount`, `unitLevel`,
    `baseLevel`, `effectiveStacks`, `effectiveLevel`,
    `_lastAppliedEffectiveLevel` are columns (NaN = unset; getters return
    undefined). SIM_KERNEL_EFF_UNITS does the strided share from columns
    (window counts, stacks, levels); objects are touched only when the
    effective level changed or the kernel cannot answer (no base tables:
    `esOk`, kept by `effStatsUnitBaseChanged`, cleared on decode and stat
    version changes). `_effStatsFullUnit` is the object path.
13. Coverage hold end: queued slots are deduplicated (`vsHeld`), and
    SIM_KERNEL_VIS_HELD settles those whose window covers the same areas
    (shared `sourceAreaZoneTable`). About half still change area lists
    (border crossings) and need ring updates on the main thread: hold end
    stays ~15 ms (parallel ring updates with atomics are possible: final
    state is order-free).
14. Parked idle workers stay parked through their periodic search ticks
    when the kernel finds their work version unchanged (pure
    `_workerWorkHash` replicated in SIM_KERNEL_MOVE from a shared version
    table, origin tile, reach; mvFlags 2), and builders through watchdog
    samples while unmoved (mvFlags 4). Idle-worker updates in base
    ~6000 → ~2700 per tick (unit pass 47 → 29 ms).
15. Separation: each tile's member bounding box (prepare kernel, integer,
    outward) lets the kernel skip neighbour tiles out of reach exactly
    (outputs identical, checked by hash); ~25 → ~21 ms. Remaining cost is
    ~43 candidates scanned per unit for ~2 contacts (reach inflated by the
    largest unit radius 12, cross-team padding 16 and the 16 px index
    margin).
16. Building update order: the per-list sorted order is cached by
    reference (keys are immutable; decode drops the caches), filtered on
    removals, and sorted on numeric keys otherwise (siege: 57.6 → 10.7 ms;
    `tests/deterministic-sort.test.cjs` checks it against the comparator).

Each large-world path has a threshold tests can lower:
`SPATIAL_PARALLEL_MIN_UNITS`, `SNAP_HASH_KERNEL_MIN_UNITS`,
`EFF_STATS_KERNEL_MIN_UNITS`, `VIS_HELD_KERNEL_MIN`. Chaos-based tests take
`CHAOS_SIM_EVAL="..."` (run on every peer at one tick, e.g. all of them = 0);
the equivalence test also takes `HOST_SIM_EVAL` (host only: a kernel path
against the guest's object path, every field compared).

Verified this round: kernel-object equivalence (default cases, with the
kernels forced on via CHAOS_SIM_EVAL, and host-only via HOST_SIM_EVAL for
eff stats / index / vis hold), chaos determinism crossroads+islands with the
large-world paths forced, parallel-kernels, spatial-index-builds,
deterministic-sort, shared-unit-state (updated: slot reuse is deferred),
visibility tests. NOT yet run on this round's changes: the full determinism
suite in both modes (see next steps, item 0).

### Workload coverage to add (user request, 2026-10-01)

The 100000-1000 benchmark has only ~400 towers (7392 barracks, 5508
spawners, 22326 floor items). Realistic games have towers in the 5-10k
range, like barracks. Add benchmark modes and measure:
- 5-10k towers spread over both bases (mixed types, lasers included);
- towers engaging towers (opposing tower lines in range of each other);
- units engaging towers (armies sieging tower lines), and towers firing
  on units (projectiles, lasers, splash), with mixed structures;
- keep BASE/ACTIVE/BATTLE alongside, and the determinism tests on the
  same kinds of fights (chaos worlds already mix them at small scale).
- a few thousand traps (lava, water, ice, poison, sand, mines) and units
  crossing them (lower priority: their reach is one tile, simple to make
  cheap).

First measurement (`benchall.sh ... siege`: TOWERS=8000 per team, 16400
towers, plus BATTLE=mix): p50 664 ms, mean 722. Unit pass 281 (attacking
buildings 80 ms / 10456 updates, attack-move 84 / 6858, chase 60 / 12719,
idle combat 51 / 5667, firing 46 / 9026), building update-order sorting 58,
simMoveRun 51, resync 44, towers 35.

### Next steps (in order)

Current order (sixth round; the plan's "Fifth refinement" has the
details): opportunity tables for idle searches; combat units moving
unarmed (`c1`) and remaining hand-backs as mover events; movement orders
snapshotted and the object movement code removed (one path); worker
logistics as a typed background job; hashing as an L1 job; building layer
at K-tick cadence; towers/projectiles (J1/J2); closest-reachable routing.
Run the full suite on a snapshot copy after each batch. The list below is
the older one, kept for its details.

0. Run the full suite on the third round's changes before anything else:
   `node tests/run-regressions.cjs 4 --filter="multiplayer-(chaos|desync|snapshot|patch|matrix|scenarios|action-fuzz|cross|corruption|border|extremes|host-mig|late)|shared-|sim-frame|parallel|kernel-object|laser|worker|collector|drive|research|spawner|combat|structure|battle|spatial-index|deterministic-sort" --output=../.reg.json`
   (both modes, ~1 h), then the rest in mode 0, and the chaos/patch/
   corruption tests again with
   `CHAOS_SIM_EVAL="SPATIAL_PARALLEL_MIN_UNITS = 0; SNAP_HASH_KERNEL_MIN_UNITS = 0; EFF_STATS_KERNEL_MIN_UNITS = 0; VIS_HELD_KERNEL_MIN = 0"`.
1. Siege workload (towers in the 5-10k range, the realistic case):
   attack-move units 12 us each (structure scans every 4th tick and kernel
   hand-backs: hostile structures are always in reach), units attacking
   buildings 7.7 us each (no kernel mode for building targets yet), towers
   37 ms (plan J1: due-shot batching), projectile rank map 11 ms (cache it
   by list references like the building order), building statuses
   (`tickStatusEffects` on all ~35k buildings every tick; keep an active
   set, plan L2), thing stats 24 ms (plan C), statusPrepass 13 ms.
2. Combat kernels: chasers with paths (~70% of chasers; needs exact undo
   of path progress and A* charges at the turn check, or a proposal applied
   at the turn), firing ticks of held units. Queueing mine damage like
   hits would remove mid-pass deaths (the reason for turn re-checks).
3. Separation (~55 ms base, kernel ~21): smaller reach (index margin 0 by
   bucketing current positions in the prepare step; per-owner/radius
   classes), pair-once (plan F); simMoveRun serial part (slot updates
   ~13 ms: move the tile/zone/area/mask/count bookkeeping into a kernel
   with a flag list), coverage ring updates (hold end ~15 ms: atomics).
4. Hashing (~25 ms): building statics, list order, slice unit objects
   (more state in columns, plan stage 2).
5. Workers in ACTIVE (MOVING_TO 23 us each, searches 30 us each): plan A.
6. Unattributed `gameTick` inline loops (dead-unit pass over every unit,
   upkeep): measure with TOPPHASES and move to columns.
7. Pre-existing failure, unrelated: `tests/flat-gpu-renderer.test.cjs`.

## Plan stages (from the plan, §4.2) — status

| Stage | Work | Status |
|---|---|---|
| 0 | Determinism repair (prerequisite) | done 2026-10-01 |
| 1 | Measurement corrections, state coverage, pure/mutating helper audit | in progress (profiling-driven fixes; tickbench diagnostics UPDSPLIT/CHASESTAT/AFTER) |
| 2 | Field manifest, handles, canonical order, activity lists, journal | started: level/stack columns, slot-based unit index |
| 3 | Exact batch statistics and typed healer top-k | unit effective stats in kernels done; thing stats open |
| 4 | Worker travel, deadlines, assignment and economic commit | idle parking with kernel version checks done; assignment open |
| 5 | Normal-unit combat, chase, cooldown validation, statuses, hit commit | started: scan-before-move, kernel chase (no path) |
| 6 | Projectile structure broad phase; due-turret queries | — |
| 7 | Navigation demand/local rebuilds | — |
| 8 | Laser topology/strip queries; changed-only production | — |
| 9 | Spatial/visibility/lifecycle cleanup; pair-once separation | index fill in kernels, coverage hold kernel, separation box culling |
| 10 | Typed hashing and indexed repair | started: hash 44.8 → 24 ms |
| 11 | Direct frame encoding and grid deltas | — |
| 12 | Whole-system optimization and acceptance | — |

## Measurements

`bash .claude/benchall.sh <outdir> <tag> [base|active|battle]` (100000-1000 map, HELPERS=7).
Unit-pass split (`upd`): ms per tick and calls per tick by state (w: worker state, c<cmd>: combat command).

2026-10-01, after the determinism repair (stage 0):

| Workload | p50 ms | mean ms | max ms | Largest items (ms/tick) |
|---|---:|---:|---:|---|
| base | 374 | 381 | 1136 | unit pass 123 (idle workers 83 / 28254 calls), separation 51, resync 43, spatial index 35, simMoveRun 33, effective stats 28 |
| ACTIVE=1 | 560 | 703 | 4298 | unit pass 277 (idle workers 266 / 9857, MOVING_TO 259 / 3661 = 70 us each), resync 53, separation 49, simMoveRun 38 |
| BATTLE=mix | 740 | 836 | 2776 | unit pass 293 (idle workers 228 / 16733, attacking 130 / 31955, attack-move 120 / 26070), resync 44 |

After the first optimization slices (laser links, salvage index, idle parking):

| Workload | p50 ms | mean ms | max ms | Largest items (ms/tick) |
|---|---:|---:|---:|---|
| base | 317 | 342 | 759 | separation 51, resync 44, simMoveRun 33, unit pass 33 (idle 30 / 5991 calls), spatial index 32, effective stats 26 |
| ACTIVE=1 | 529 | 578 | 1446 | unit pass 189 (idle 220 / 5041 = 44 us each, MOVING_TO 83 / 3661), resync 55, separation 50, simMoveRun 38 |
| BATTLE=mix | 650 | 750 | 2503 | unit pass 266 (idle 194 / 6913, attacking 131 / 31955, attack-move 116 / 26070), resync 41 |

End of 2026-10-01 session (all slices 1-6; full determinism suite 68/68 in both modes):

| Workload | p50 ms | mean ms | max ms | Largest items (ms/tick) |
|---|---:|---:|---:|---|
| base | 319 | 334 | 734 | separation 51, resync 44, unit pass 34, simMoveRun 32, spatial index 31, effective stats 26 |
| ACTIVE=1 | 484 | 546 | 1449 | unit pass 152 (idle 149 / 5041, MOVING_TO 85 / 3661), resync 52, separation 49, simMoveRun 38 |
| BATTLE=mix | 497 | 529 | 1147 | unit pass 227 (attacking 130 / 31955, idle 123 / 6913, attack-move 117 / 26070), resync 43 |

After the third round (base: TOPPHASES with more phases; siege: new mode):

| Workload | p50 ms | mean ms | Largest items (ms/tick) |
|---|---:|---:|---|
| base | 266-275 | 292-299 | separation 53-56, simMoveRun 36-38, unit pass 29, resync 26, thing stats 15, hold end 15, building statuses ~5-14 (wrapper inflated), vis sync 11, index 11, barracks ~9-11, eff stats 8 |
| siege (TOWERS=8000 + BATTLE=mix) | 628 | 686 | unit pass 284 (attack-move 84 / 6858 calls, attacking buildings 81 / 10456, chase 62, idle combat 50, firing 46, idle workers ~150), simMoveRun 51, resync 45, towers 37, separation 27, thing stats 24, statusPrepass 13, runQueuedOrders 12, projectilesBegin 11, building order 11 |

Before (previous session's last records):

| Workload | p50 ms | mean ms | Largest items (ms/tick) |
|---|---:|---:|---|
| base (idle economy) | 417 | 422 | unit pass 136, simMoveRun 66, separation 66, resync 42, effective stats 39, spatial index 30 |
| ACTIVE=1 | 728 | 969 | unit pass 439 (idle workers 498 ms over 7192 updates, MOVING_TO 422 ms / 3288) |
| BATTLE=mix | 985 | 1094 | unit pass 521 (attacking units 435 ms over 94813 updates, idle workers 291 ms / 17954) |

Target: complete tick ≤ 50 ms.

## 2026-10-20: 4M checkerboard TPS pass

Added `tests/checkerboard-tps.bench.cjs`: initially 4M units, 125k mixed opposing towers, 1000×1000 map, small opposing groups, real main-thread simulation and seven helpers. Paging/allocation/GC stalls stay in whole-tick wall times; no machine cleanup or memory prefaulting. Use Node 24+ memory64.

Reference runs averaged 808–822 ms/tick (1.22–1.24 TPS). Optimized repeats averaged 628–694 ms; the final equivalent 12-tick window was 693 ms / 1.44 TPS, about 18% higher TPS. Normal deaths leave 3.29–3.38M units during these windows. Saved 83 MiB of live WASM scratch allocation and approximately 81 MiB of ID-index storage. Cleanup phase fell from 105–166 to about 45–57 ms/tick.

Changes: full-width memory64 helper addresses; typed heap-binding descriptors to avoid cloned-view offset truncation above 4 GiB; atomic initial binding publication and protected registry checks; paged unit-ID lookup; smaller large-population spare buffers; contiguous dead-slot sweep blocks; early SIMD contact rejection and a stationary-contact fast path. Also fixed the collection cursor skipping most slices indefinitely under adaptive dk=4/20: it now advances once per simulation step.

Both WASM variants rebuilt. General tests are the acceptance bar, as requested; full-scene hash differences are not a gate for this work. Detailed results, validation and repeat commands: [4M TPS report](tests/test-runs/checkerboard-tps-20261020/README.md). Remaining top costs are `sep_pairs`/`mv_move` and their waits, the unit update pass, spatial indexing, and detached-value construction.

## 2026-10-20: movement response and shared navigation

Fresh 4M checkerboard profiling: `simMoveRun` 249 ms including nested work; the movement dispatch itself 114 ms, all background waits 117 ms. Added a SIMD sleeping-contact shortcut that preserves contact/brake history while skipping response normalizations when there is no movement, flow or carried/closing force. Exact movement replay against the original kernel passes at dk 1/4/20, including force and wake-up fallbacks. A two-contact exact SIMD trial was slower and was removed.

Equal wall/cost navigation profiles now share immutable geometry (fields, graph, components, atlas), retaining independent wrappers, versions, sequences and destination fields. Rebuilds and snapshot restores also reuse it. Live WASM allocation falls **4415 → 3785 MiB (630 MiB saved)**; cold first tick falls from 27.5 s to about 23.3–23.4 s. Shared-geometry repeats measure **625–686 ms / 1.46–1.60 TPS**, against a fresh **706 ms / 1.42 TPS** baseline. Variation remains large; no precise independent shortcut speedup is claimed. Final repeat movement dispatch is 115 ms, so collision pairs/waits and movement remain the leading targets.

Broader main-thread regressions: 25/27 pass; four additional simulation-worker checks pass (29 passing total). `nav-rows` and `separation-rally` reproduce the exact pre-existing failures from the earlier full run. Neither test was weakened. Report, profiles, baseline bundles, and validation: [movement TPS report](tests/test-runs/movement-tps-20261020/README.md).

## 2026-10-20: shared stat storage and structure refresh removal

Unit hot stats now read shared owner/type/level rows; six per-unit Float32 caches and their writes are removed, with 16-bit row handles. Unit WASM columns total 517 bytes/slot. Paged optional references, interned shared references and movement fixes are documented in [unit/stat report](tests/test-runs/collision-tps-20261020/README.md). The matched reverse-order 32-tick comparison measured 620.12 vs 633.75 ms/tick and reduced live WASM allocation by 99 MiB (3785 -> 3686).

Extended flat Float32 owner/type/level tables to buildings and floors. Benchmarked level-major and stat-major tables; retained stat-major. Deleted per-instance stat/cache columns, building research versions/catch-up/sweep jobs and their main tick call, periodic building/floor refresh buckets, selected-structure stat refresh, adjacency stat-object rebuilding and four adjacency signature columns. Towers save about 70 column bytes/slot, producer/floor rows 76, mines 16. Research updates shared rows directly; maximum-level research retains upgrade eligibility work. Linked values are calculated from unrounded temporaries before Float32 stores so in-place research/boost publication matches full rebuilds.

Two serial comparison orders at 4M units / 125k towers / 1000-square map, seven helpers, three warm-up and 24 measured ticks: retained shared tables 572.63 vs cached 586.44 ms, then retained 527.98 vs cached 551.73 ms. TPS is 2.4–4.5% higher in those comparisons; tower processing 18–25% lower. Paging/GC stalls remain in tick times. Hardware memory traffic is unavailable with this Windows user's PMU permissions, so column savings are not claimed as measured DRAM traffic.

A received-plus-outgoing contact-budget trial failed to repeat its initial benefit and was reverted with source-matched production WASM binaries. Its source, binaries, profiles and raw runs remain in the [structure/stat report](tests/test-runs/structure-stats-20261020/README.md). Collision pair processing and waits remain the leading target.

Final shared-structure validation: 22/22 main-thread and 4/4 simulation-worker checks pass, plus contact replay and syntax checks. Detailed final records: tests/test-runs/structure-stats-20261020/validation-summary.json.

## 2026-10-22/23: real-scene TPS pass (tests/4M-1K-move-fight-low-tps.gz, 2.3M units)

Scene, tools and findings are in `tests/test-runs/tps-scene-20261022/` (run5/ has the A/B scripts, builds and logs) and the user's memory notes (defence3-scene-tps-workflow).

* Edge steps this scene in `simDk = 20` base ticks (adaptive pace); the Node 24 bench reproduces it with `EVALCODE='SIM_ADAPTIVE_STEPS=true; netStepTicks=()=>20;'` (`run5/ab.sh`, `abx.sh`; `HASH_AT` proves exactness). Rendering is not what slows the simulation.
* Exact changes (state hash identical): `k_ixd_apply` radix sort + `k_ixd_owners` per-chunk dedupe (index wait 85 -> 55 ms/step); acquisition area build computes each entry's key once; **nearest-spawner field** (`k_ws_nearfield`, chained before `k_ws_scan`): the collectors' anchor-less spawner search scanned ~915 buckets / 700 spawners a request (~7 us, 28% of all CPU at 160 s into the run, growing with game time) and is now one lookup per request (a per-owner L1 distance transform with the same (steps, row, column, id) tie-break; `WS_NEARFIELD=false` turns it off, same results); no per-call allocations in `navAtlasStep` (pointer numbers cached) and `_simMoveStructs` (dims string).
* Behavioural, scale-adaptive housekeeping: vis-cover safety-net sweeps and the work-site grid sweep 4x slower at >= 250k units, presentation metadata pump 4x rarer at >= 1M units, presentation frame pool 2 buffers from 192 MB frames (-345 MB).
* Edge mean step: ~1090 ms -> ~800 ms in the first 40 s, ~950 ms averaged over 2 minutes (the load grows as the jam develops); the ws tier no longer grows with game time.
* Tried and dropped: compiler flags (-O4 --converge, inline-threshold, unroll-threshold: within noise; --lto-O3 is a no-op), next-unit "touch" prefetch (+7-14% slower), batched swap probe (neutral).
* Memory census (2.3M units): renderer commit 12 GB / WS 6 GB; wasm heap 6.5 GB (3.2 live, 3.3 freed from the 5.4 GB load peak), JS heaps 1.2 GB (sim worker) + 0.74 GB (page). JS-heap objects (~0.6 GB): lazily cached area-graph rows (arrays of arrays, ~250 MB, grow with queried areas), worker role-memory `_rm` objects (434k x 240 B), ~1M static `{x,y}` area-cell objects. GC trace: sim worker's longest pause 605 ms (incremental-marking start), ~6 s of GC per 150 s; page main thread 227 ms major GC. Slow steps slow every phase together (paging stalls at barriers: 2-14k pages/s in on the user's 16 GB machine).
* Next candidates: area-graph caches to typed CSR/bounded, role memory to columns, static cells to typed arrays (JS heap and GC marking); `traffic_swap` chunk culling at dk=20; parallel acquisition area build; tower/`shoot` allocation.

## 2026-10-23: memory, leaks, layout and helper count (same scene, plus a ~10%-workers variant)

Tools: `.claude/wsmap.ps1` + `wsjoin.cjs` (resident pages per array), `gctop.cjs`, `colstatic.cjs`/`colaudit.cjs`/`colaccess.cjs`/`wcount.cjs`/`mvfields.cjs` (unit-column audits), `profsum.cjs`, `heapretain_stream.cjs` (`CENSUS`, `DETUNITS`, `CLIMB_ALL`), scene helpers in `tests/test-runs/tps-scene-20261022/run5/` (`mixworkers.cjs` makes `tests/scenes/4M-realistic.gz`, `sortscene.cjs`, `ab3.sh`).

* **Load-time memory (earlier today):** unit columns reserved once, no prepay, x1.125 growth: wasm heap 6.5 -> 3.2 GB committed (1.6 GB resident), Edge renderer private 12 -> 8.3 GB. Mid-game GC is quiet (sim worker majors only during load; page majors <= 170 ms).
* **Leaks found with two heap snapshots (60 s vs 420 s):** dead units' detached records (`_det`, ~0.45 KB each) were kept alive by (1) the serial spatial index's object lists `_sxList`/`_sxAList`, never cleared once the parallel (by-slot) index took over (68k of 95.7k detached units after 6 minutes), (2) the legacy `_simRenderSlots.owner` table of the first frame encode (27k). Both released now (chunk.js at the two `_sxBySlot = true` sites; sim_frame.js `simFrameReleaseBuffers`). Sim-worker JS heap, 2.1M-unit scene: before 645 -> 775 MB over 250 s, after flat at 590-665 MB over 400 s.
* **Occupancy footprint record:** `occ.rec`, 16 B a slot (x, y, radius | layer << 8 | active << 16 | need << 24), replaces occ.x/y/radius/layer/active/need: stage 2 -5%, exact. (Job-local chunk-record cache for the swap scan: no effect.)
* **Helpers:** the default is now `max(ceil(cores/2) - 1, min(cores - 5, 15))` (11 on 8C/16T, was 7): same results, Edge sim step 779 -> 645 ms on the 2.1M-unit realistic scene, frames unchanged (7/11/14 helpers: 779/645/661 ms). `?simhelpers=N` overrides.
* **Slot locality (Node, dk=20):** Morton-sorted slots: tick -8%, stage 2 -21%; shuffled slots: tick +54%, stage 2 +51%. The real scene is already ~98% adjacent in index order; a long game's free-list reuse drifts toward shuffled. Not addressed yet (ideas: slab/region-aware slot allocation, background slot sort).
* **Profile of the realistic scene** (all sim threads): stage 2 family ~53% of CPU (`traffic_swap` 12%, `move_job` 6.5, `traffic_yield` 6, `seg_open` 6, `checked_traffic_q` 4, `occ::motion`/`horizontal_motion` 7), acquisition (area build serial 6.5%, sample 4.3), `k_vis_seed` 3.2, `k_ws_scan` 2.7. At dk=20 nearly every visited unit does a yield move (72% move) and ~1/4 try a swap (24 index entries a call, 20% succeed).
* **Removed (dead with the combat brain, which is always on):** the drive-by look kernel (`SIM_KERNEL_DRIVEBY`, `mv_driveby`), its columns `dbT/dbTI/dbS/dbTick`, the answer branch in `Unit._driveByScan`, the look-by-area chains in `step_flow`/`move_flow`/`steady_until` (`Mv.brain` is the constant `BRAIN`). State hashes identical at dk=1 and dk=20 on both scenes; 25 focused tests pass. Still there: the area-box machinery (its epilogue check lists units for the JS post loop, so removing it is not provably exact), the `mvFire` column (now never set).
* **Where the resident set is (2.3M units, Edge renderer WS ~4.5 GB):** wasm heap 1.6 GB (unit columns 0.77: 105 columns fully resident, 66 uniform in the scene; registered arrays 0.6: acq 191 MB, ixd 67, mv 47, ix 43, occ 42, hc 39), presentation frames ~0.75 GB (116 B/unit, two pooled buffers + the page's summaries), JS heaps ~1.5 GB, GPU process 0.58. Ideas not done yet: per-row (flyweight) storage for the columns that are functions of (owner, type, base level, effective level) (~20 columns, ~60 B/unit), sparse combat/worker records, frame record diet, typed `workerReservedTiles`.
* Leak fix verified with two new snapshots (60 s, 420 s): units with a detached record held by the lists: 0 and 28 (before: 6.5k and 68k + 27k); heap nodes 18.78M -> 18.52M (before 19.18M -> 23.62M).
* Edge, the user scene (2.26M units, dk=20), all of the above: mean step 572 ms, p95 732 ms, 1.4 steps/s, frames 26-29 fps (800-950 ms before today; the helper default is most of it). HUD summary map held a 282 MB early frame for the whole match: now a WeakRef. End-to-end determinism/restore/snapshot tests (18) and the 25 focused kernel/occupancy tests pass.

## 2026-10-26: 1M mixed-chaos outlier profiling

Priority is the lowest stable tick time, especially outliers, without a fixed TPS cutoff. Startup is excluded. Added a portable million-unit chaos benchmark with mixed fighting, economy, workers, research, construction, rally and command bursts; 11 real helpers, wasm32 and dk=20. Whole-step wall times include GC and event-loop yield. CPU profiles can capture every helper and slice the worst tick or a named phase; allocation sampling separates gameplay from synthetic input generation. Commands: [benchmark notes](tests/CHAOS_SPIKES_BENCHMARK.md).

The matched 260-sample window improved from **418.8 ms mean / 579.8 p99 / 639.0 maximum** to **363.5 / 443.7 / 491.5 ms**. Steps over 500 ms fell from 14 to zero in that window. A longer 400-step capture (380 steady samples) measured **378.2 ms mean, 445.8 p95, 494.2 p99, 538.0 maximum**, with two steps over 500 ms and none over 1.5 times the median. Later gameplay gets heavier; the longer tail is retained rather than hidden by the shorter comparison. The worst long-run tick overlapped 38 ms of GC. A CPU capture starting at step 280 found another slow tick with only 3% more process CPU for 23% more wall time, consistent with scheduling/contention contributing. Nine helpers were worse (416.6 mean / 549.8 p99 / 576.6 maximum), so the default remains eleven on this machine.

Retained: navigation sweep locality, a bounded atlas tile-step cache, per-look invariant exit-cost reuse with four-exit SIMD scoring, two-sample f64 SIMD segment checks, and choosing the parallel full index merge for busy large-world steps. Allocation profiling found the worker-event sort comparator returning large floating differences allocated an estimated 118.6 MiB over 220 steps: returning -1/0/1 reduced that to zero. Reusing the spatial-count queue and indexed resource loops removed a further estimated 165 MiB of simulation allocation churn in a matched allocation-profile run. Player orders still apply in their original tick.

Memory remains an acceptance constraint: no new per-unit columns; atlas caches use existing thread-stack space. The tile cache is kept at 512 entries, and the new exit cache is approximately 528 bytes per active wasm32 look. The persistent JS count queue retained **256 KiB**, outside the wasm32 address space. WASM live allocation remained **1414 MiB**, peak **1421 MiB**; both preceding and retained 400-step captures committed **1940 MiB**. No reduction in the separate multi-million-unit 4 GiB capacity problem is claimed. Larger/cross-unit atlas-cache trials and histogram aggregation were removed after weak or worse overall results.

Both WASM variants rebuilt (`012e531a4611aaaf` / `cbabf6d507b841fc`). Regression suites for these changes remain deferred at the user's request. Raw runs, profiles, rejected trials, memory figures and comparison details: [chaos spike report](tests/test-runs/chaos-spikes-20261026/README.md).

## 2026-10-27: dense-chaos structure-index spikes

The first measurements in this section describe the intermediate batch version. The later rolling-journal follow-up below is the final implementation.

This continues the already-retained [dense workload and turret/spawner pass](tests/test-runs/chaos-dense-20261026/README.md), which was not yet linked here. That fixture fills 250,000 structures and positions the full starting army (1,000,004 units); its results are separate from the older sparse chaos report above. Production WASM is now `7268f4d0c6f19362` / `18802f7ca0e70ac0`; this pass changes JavaScript only.

All-thread profiling compared previous/slow/next steps 60/61/62 with same-action-status reference 72. The slow tick was 1902 ms versus 1074 ms, with 126 ms overlapping GC. The expanding worker-search stack repeatedly copied whole type-filtered structure lists for each changed tile: `_tileOrderedReplace` accumulated about 343 ms of sampled inclusive time versus 5 ms in the reference. Batched those edits into one copy per affected type, preserving old lists held by searches and metadata/ownership invalidation even when the entity reference stays the same. Tile-array merges now write directly into their final array. Resource additions avoid two redundant stockpile normalizations; tower sorting uses existing tile keys with a detached-entry fallback. No new per-unit columns, AI delays or deferred player orders. The benchmark now traces the worker tier and resource/research/shrine/pop-cap phases.

Serial dk=20, eleven-helper, 280-step comparison (260 steady samples): **991.1 → 873.4 ms mean; 1361.6 → 1157.4 p95; 1685.6 → 1309.1 p99; 2286.5 → 1812.3 maximum**. Steps over 1500 ms fell **6 → 1**, and over 1.5 times median **12 → 9**. A shorter reverse-order pair (120 steady samples) showed a smaller tail gain: p99 **1385.6 → 1337.1**, maximum **1533.7 → 1385.9**, but mean **967.6 → 979.0** and p95 **1227.4 → 1265.3** were worse. The long-run gain did not fully repeat; no universal tick-cost improvement or elimination of multiplayer hitches is established. dk=1 AB/BA checks (80 steady samples each) reduced maximum **661.1 → 612.8** and **733.1 → 590.6 ms**, with means **385.3 → 380.1** and **399.6 → 378.4**; the first pair's p95 worsened.

Measured long-run population: **367,389–450,794 before; 366,972–450,795 after**. Successful cumulative energy/astar deposits: **236,312/206,677 → 236,055/206,621**; research deposits **8855 → 8988**, construction completions **19,179 → 19,112**. All four dk=1 captures have identical population bounds and work counters. Long-run WASM peak/committed memory stayed **1665/2182 MiB**; end live allocation was **1606 → 1614 MiB**. Sampled maximum JS heap usage rose **1812 → 1961 MiB**: no overall memory saving is claimed. Raw ticks, worker activity, throughput, births/deaths, GC and memory remain in the [report](tests/test-runs/chaos-spikes-20261027/README.md) and its JSON/JSONL files.

Final focused validation: **12/12 checks across both execution modes**, including six-map multiplayer chaos, boosts/shrines, tile-list equivalence, zero/three-helper SIMD combat, and 800 independent type-index/grid comparisons covering held lists, metadata invalidation and resets. Additional helper/memory64 checks are retained in the report. **Dense stress-fixture repeatability remains unresolved:** small same-source gameplay-counter drift also appears with the saved baseline, and retained same-source runs drift too. Focused peer/helper tests pass, but the dense timing captures are not proof of full-scale deterministic replay; this is distinct from optional historical hash equality and needs a separate audit.

The intermediate batch version's remaining worst long-run tick was step 212, **1812 ms**, including **869 ms worker-search tier** and 24 ms overlapping GC. Its neighboring steps were 1157/721 ms and same-status reference 224 was 743 ms; foreground movement stayed roughly 213–219 ms across those four ticks. Full measurements, source snapshots, commands, validation and profiling limits: [2026-10-27 report](tests/test-runs/chaos-spikes-20261027/README.md).

### Rolling-journal follow-up

A late all-thread profile isolated the remaining worker-tier spike to **full cache rebuilds**. Its slow step 210 was 2374 ms versus same-burst reference 200 at 1207 ms, with neighboring 209/211 at 1529/941 ms. Sampled inclusive time was about **519 ms in `_wswBuild` and 386 ms in `_ownedStructureBuckets`**. The tile-change journal discarded its entire log at 262,144 entries, making even current index cursors expire together during gameplay.

Replaced whole-log disposal with a lazily grown Uint32 ring, bounded at **1 MiB outside WASM**. Current readers keep exact sorted/deduplicated deltas across rollover; only readers more than the full retained window behind expire. Epoch resets still rebuild. This removes false cache invalidations without deferring index updates. Added rollover coverage and per-tick journal/rebuild attribution. **14/14 focused checks pass across both execution modes**, plus a final memory64 zero/three-helper combat replay and **6400 baseline/current resource-mutation equivalence checks**.

The first final 280-step capture (260 steady samples) records **zero work-site-grid rebuilds after startup**, versus the intermediate version's late full rebuild. Worker-tier time at step 212 fell **869 → 50 ms**; the final run's worker-tier maximum was 208 ms. Whole-step steady **mean 936.3 ms / p95 1276.4 / p99 1380.2 / maximum 1435.0**, with **zero steps over 1500 ms** and four over 1.5 times median. The earlier intermediate capture was faster on average (873.4 ms) but had the 1812 ms rebuild hitch; the original baseline was 991.1 ms with a 2286.5 ms maximum. Treat overall averages as machine/workload-sensitive, not an isolated journal speedup. Final measured population is **367,711–450,803**. WASM peak/live/committed allocation is **1665/1606/2182 MiB**.

These steady figures exclude twenty warm-up steps. The first actual simulation tick still takes **15.9 seconds** in this mass-created fixture; all-gameplay p99/max are **2440/15,893 ms**. This is early gameplay work, not setup time before the timed loop, and remains a separate unresolved hitch. The dense same-source repeatability audit also remains open. Continue with those limits and sustained movement/worker-event/command costs after the journal spike. The final paired comparison and complete counters are in the linked report and `journal-*` raw files.

The completed isolated journal-only pair compares the final ring against the intermediate batch implementation, 260 steady samples each: **929.4 → 936.3 ms mean, 1253.3 → 1276.4 p95, 1469.1 → 1380.2 p99, 1854.5 → 1435.0 maximum**, with steps over 1500 ms **2 → 0**. The reference explicitly rebuilds at journal rollover on step 202 (503 ms `_wswBuild`, 923 ms worker tier); the final run has no post-startup rebuild. This supports the targeted hitch fix, not an ordinary-tick speedup. Sampled maximum JS heap is **1900 → 2097 MiB**; occupied heap is not retained live memory, and no total-memory reduction is claimed.

The final dk=1 original-reference/current check has **429.8 → 418.8 ms mean, 573.0 → 542.6 p95**, but a worse **724.1 → 786.1 ms maximum/p99** across 80 steady samples each. The final maximum is a command-burst tick with 35 ms overlapping GC; phase traces alone do not explain all of its expansion. Full counters and neighboring-tick details are retained in the report. Do not generalize the dk=20 journal-tail improvement to every workload.

Remaining dk=20 costs: a final **1380 ms non-burst tick** spends **343 ms in worker AI/events, 317 ms movement and 314 ms towers** (71% combined), plus 148 ms worker search, with only 16 ms overlapping GC. A **1376 ms burst tick** spends 313 ms applying/queuing orders, 269 ms movement, 275 ms worker events and 258 ms towers, with no recorded GC. Prioritize profiling these sustained phases next; the old 869 ms journal-driven worker-search rebuild is no longer the dominant cause.

### WASM/SoA tower batch (later on 2026-10-27)

Follow-up measurements: batch 2's fresh reference/current pair measured **1039.6/970.6 ms mean, 1404.7/1467.9 p99, 1580.7/1471.4 maximum** (120 steady samples). The roughly 7% average difference remains inconclusive. Named all-thread profiling of non-burst slow/reference ticks **81/74**, with neighbors **80/82**, shows worker events expanding **318.5 → 437.2 ms** with zero overlapping GC, while movement stays expensive throughout. Native atlas exit scoring, segment checks and traffic dominate helper CPU; tower sorting and repeated object/stat access remain foreground costs. Summed helper CPU samples are not elapsed wall time.

An aligned eight-node AoSoA navigation-field trial with wider SIMD scoring and pooled immutable path views compiled but was **reverted**: current/reference mean **1003.2/969.8 ms**, p99 **1472.7/1436.3**, maximum **1519.7/1466.3**. Movement improved, worker events worsened, and whole-tick benefit was absent. The full source/binary trial is preserved as `stage3-sources.json`; no regression suite was run on it.

Batch 4 adds dedicated stable native tower radix ordering on a helper lane and native idle-query cooldown outputs applied in tile order. Tower time fell **164.2 → 100.4 ms**, but movement/events were slower in that run, so whole-tick mean was only **933.2 → 923.7 ms**; p95 **1234.3 → 1248.1**, p99 **1386.1 → 1317.5**, maximum **1750.1 → 1380.2**. Population was **389,514–450,794 / 389,460–450,795**, with all work counters retained. This establishes a promising tower-phase reduction, not a reliable general TPS gain. Batch 5 moves repeated query rectangle scans to helpers using eight-byte structure-row SIMD checks and contiguous query columns. Both production variants compile; a fresh original-reference/current timing pair is running before acceptance/validation. Details, raw ticks, memory and throughput are in the linked batch report.

The user requested grouped WASM/SIMD, precision, layout/cache and helper-thread changes, with performance measured before spending time on determinism/regression suites. They also authorized removal of the retired debt penalty: negative stockpiles only disable boosts. Experimental changes and raw runs are in the [WASM batch report](tests/test-runs/chaos-wasm-batch-20261027/README.md). Native helper tower-building queries, f32x4 distance ranking, native radix event ordering, occupancy broad-phase/padding, and SIMD fixed-point resource batching are implemented; legacy penalty calculation/UI/snapshot machinery is removed. Both WASM variants build. The initial batch-2 comparison was inconclusive; the follow-ups above record the named profiling, rejected navigation layout, and later tower batches. Final batch-5 measurements and validation are recorded below.

Final batch-5 original-reference/current pair (120 steady samples, dk=20, eleven helpers): **1035.5 → 897.8 ms mean, 1357.1 → 1229.9 p95**, tower phase **191.1 → 87.5 ms (2.18× faster)**, worker events **271.5 → 246.3 ms**, movement **250.8 → 249.2 ms**. **Tail latency worsened:** p99 **1438.6 → 1559.5**, maximum **1497.8 → 1575.1**, ticks above 1500 ms **0 → 2**. Retain the substantial tower-phase reduction without claiming that gameplay hitches improved. Actual population **388,852–450,794 / 389,127–450,795**; successful energy/astar deposits **99,503/87,510 → 99,970/87,595**. Complete work counters and raw ticks remain in the report. WASM committed/live/peak allocation **2182/1597/1665 → 2230/1632/1700 MiB**; structure columns moved from JS to WASM, but no overall memory saving is established. The first gameplay tick still takes about 15 seconds.

The new non-burst worst tick **51** takes 1575 ms, with previous/next **50/52 at 1560/1173**, and nearby non-burst normal **42 at 964**. Worker events take **688/563/327/253 ms** at 50/51/52/42, versus towers **116/97/104/85**, and overlapping GC **41/22/24/16**. A burst-matched reference for step 50 is step 60 (1251 ms, 332 ms events). The remaining hitch expands in worker events, beyond the recorded GC; new CPU-profile slicing around those ticks is needed before choosing the next worker-table/FSM batch. The earlier all-thread profile is candidate attribution, not proof of the exact cause of this later capture.

**24/24 focused validation checks pass**, run after the substantial phase gain: both simulation execution modes, six-map peer chaos, boosts/debt, occupancy grids/shapes, shared unit state, work snapshots, full/delta compressed snapshot transport; zero/three-helper combat with native idle completion and scalar query verification under both WASM address modes. Direct tests cover **25,600 resource mutations**, **4124 broad-phase queries and stable-sort entries**, **1580 native building targets**, and native idle cooldowns across zero/three helpers and wasm32/memory64. A pre-existing snapshot test fault injection was repaired after its identical failure was reproduced with saved baseline sources: its position setter could clip away the intended corruption, so it now corrupts the column directly. No transport behavior was changed. Dense stress-fixture same-source repeatability remains an open audit; focused validation does not certify that fixture.

Production binaries: wasm32 **fb4e5fffed1bedc5**, memory64 **328e70603b689ea3**, rules revision **38**. Source checkpoints, failed trials, complete validation outputs and benchmark limitations are retained in the linked report.

### Worker-event hitch follow-up (2026-10-27)

Fresh all-thread named profiling of the retained tower batch reproduces the event expansion at steps **50/51/52**: wall **1576/1435/1354 ms**, worker events **645/540/457 ms**, versus same-status non-burst reference **42 at 1225 ms / 349 ms events**. Movement is **278/277/323/335 ms**, towers **101/106/98/105 ms**, overlapping GC **15/12/17/22 ms**. The foreground path getter has **63/51/23/18 ms** of self samples; unreachable-route handling also expands (step 51/reference 42 inclusive samples **122/41 ms**). Use these as candidate attribution: V8 inlining makes inclusive labels incomplete, and summed helper samples are not elapsed wall time.

Trialed single path reads per worker decision and direct native destination decoding for unreachable one-node routes, avoiding temporary JS path construction without adding per-unit storage or changing event budgets. **Rejected and reverted after both serial comparison orders.** Initial reference/trial (120 steady samples each): mean **906.6/897.6 ms**, p95 **1212.3/1225.2**, p99 **1295.9/1308.6**, max **1341.6/1344.2**; worker-event mean **245.5/238.2**. Reverse trial/reference: mean **881.1/845.2**, p95 **1139.8/1127.5**, p99 **1232.0/1205.5**, max **1233.6/1247.4**; worker-event mean **234.9/223.9**. No repeatable event-phase or hitch improvement is established. All runs have zero steady steps over 1500 ms; counts above 1.5 times median are **1/1/0/0**.

Initial population is one million with 250,000 structures, eleven helpers and dk=20; actual steady population spans **388,439–450,795** across these four captures. Full work/role counters, raw ticks, p95/p99/max, matched neighborhoods, profiles and source snapshots are in the [worker-event report](tests/test-runs/chaos-worker-events-20261027/README.md). WASM committed/live/peak remains **2230/1632/1700 MiB**; no memory saving is claimed. The first gameplay tick still takes **14.5–15.2 seconds**, separately retained from steady statistics. Both production JS files are restored byte-for-byte and both WASM binaries remain unchanged (rules revision 38). Restored syntax checks pass; the archived trial's small destination differential passes **480 cases**. No full regression suite was spent on the rejected trial.

Next attribution: count unreachable-route events and worker state transitions per tick to distinguish burst-driven event volume from higher cost per event before choosing native/helper batching. Sustained movement/traffic, worker AI/events and command costs remain open, along with the first-gameplay-tick hitch and dense same-source repeatability audit. This follow-up retains investigative artifacts, not a production speedup.

### Native route-event preparation and stable unfinished-building rosters (2026-10-27)

**Production target clarification:** the user identifies memory64 as legacy, about 25%+ slower in their testing and not intended for real games currently. All acceptance timings below use **wasm32**. Its 4 GiB address-space limit makes memory headroom a production requirement alongside smooth TPS: track committed memory and peak live allocation, favor bounded scratch reuse, and account for added persistent storage. Future routine optimization/validation targets wasm32; legacy memory64 checks are opt-in compatibility work.

**Priority:** maximize smooth TPS first. A dedicated memory-reduction pass can follow later; memory increases must have a concrete performance reason, remain bounded, and be measured rather than added casually.

Event census identifies **combat NOWAY events**, rather than an increase in worker FSM transitions, as the main burst expansion. At steps 42/50/51/52, combat events number **1791/23,964/15,430/1567**, versus worker events **11,226/12,627/12,549/12,447**. The preceding all-thread profile's path-view/unreachable-route attribution therefore guides a native helper batch: prepare route keys/components, then commit in the original foreground event order with the existing budgets, digest updates and retry timing. Unsupported cases retain scalar handling. Scratch storage scales with event count, not population. Step-50 event time improves in both comparison orders (**612 → 382 ms**, then **432 → 365 ms**), but ordinary event means and total tick averages do not improve consistently.

The user requested effectively L0 unfinished buildings and **O(1) completion publication**. Collector rosters now include unfinished farms/drop-off buildings from their initial build. Completion publishes the existing shared row's readiness epoch and marks its work-site tile dirty; it no longer invalidates or repacks the collector roster. Helpers prepare eligible bucket prefixes and drop-off fields for searches. Atomic next-batch epoch publication prevents helper scheduling from changing which batch sees completion. Primitive row handles avoid retaining old packed arrays; duplicate completion cannot postpone an already eligible building. Existing construction state supplies the L0/L1 distinction, without changing upgrade levels. Real placement/removal and membership changes still require index maintenance; this only removes completion-driven rebuilds. Drop-off near-field updates run on helpers.

An intermediate per-candidate readiness filter was **rejected**: reference/current mean **883.8/983.1 ms**, p99 **1374.1/1551.9**, max **1425.4/1713.9**. Helper compaction replaces that hot-loop branch. Final route-only reference/current, current measured first, 120 steady dk=20 samples with eleven helpers: **917.6 → 915.0 ms mean, 1250.7 → 1214.6 p95, 1540.3 → 1340.0 p99, 2011.2 → 1442.8 maximum**, ticks over 1500 ms **3 → 0** and over 1.5 times median **3 → 1**. Event/search/movement means are essentially unchanged. This single final pair supports retaining the requested completion architecture, but does **not** establish a general TPS improvement or repeatable overall tail reduction. Initial route-only AB/BA measurements, the failed trial and raw ticks are retained in the [event-batch report](tests/test-runs/chaos-event-batch-20261027/README.md).

Final current/reference population **389,207–450,794 / 389,435–450,801**; construction completions **17,100/17,082**, successful energy/astar deposits **99,267/87,336 versus 99,499/87,425**. All work, births/deaths and role counters remain in raw JSON. Reference/current WASM committed/live/peak **2230/1635/1703 → 2230/1637/1704 MiB**; maximum sampled occupied JS heap **1866 → 1951 MiB**. Additional per-work-site eligibility arrays mean **no memory saving is claimed**. First actual gameplay tick remains **15.4 → 17.2 seconds** and is retained outside the steady summary.

Final previous/slow/next steps 19/20/21 and same-burst normal 30 take **1238/1443/1149/1249 ms**. Events are **295/353/311/288 ms**, movement **276/270/250/253**, worker search **55/60/43/41**, overlapping GC **11/28/10/14**. These final captures have no new all-thread CPU profiles; the earlier profile guided the change but does not prove the cause of the final maximum. Sustained movement/traffic, worker AI, commands, first gameplay tick and dense same-source drift remain open.

Production WASM hashes **364592b7a032ae85 / ccb7503e0b52a57a**, rules revision 38. Focused native route equivalence covers **1452 cases per mode/helper combination**, completion publication **1058 near-field comparisons per combination**, and scalar/zero-helper/three-helper replay hashes agree in both address modes. Full validation outcomes and the actual simulation-worker verification are recorded in the linked report.

**17 production validation jobs pass**, plus changed-file syntax checks: native/helper/search checks, worker regressions, state/orders/snapshots, six-map peer chaos at 40 seconds per map (2598 compared tick hashes/map), and explicitly activated simulation-worker chaos at 12 seconds per map (915 compared hashes/map, 20 unit types, 27 command kinds). The initial longer worker run hit its 240-second harness timeout; the shorter complete rerun is reported separately, not as proof that the longer run passed. An initial legacy memory64 area-test setup failed to enable its requested mode; its fixture was corrected, with no further legacy rerun after the production-target clarification. Raw failures, reruns and limitations remain in the report. Dense timing-fixture same-source drift remains unresolved despite focused peer/helper validation.

### Completion/passability audit

The user proposes the same L0/type eligibility test for movement, collision and pathfinding. The existing hot collision representation already reduces that rule to one byte per tile: `structureWallSync` changes the completed tower's tile, `simMoveTileTypeChanged` updates `mv.wall[t]` and bounded neighboring block versions, and native movement reads that byte. Adding object/type/level reads to every movement query would duplicate this cached predicate; no extra per-tile readiness array or such hot-path change was made.

Cached navigation also contains connected components, cluster exits and destination fields. Closing the only doorway changes distant reachability, so checking the current tile prevents entering the wall but cannot repair those derived answers. Current `navWallChanged` only updates a difference count; `navTick` stages the derived rebuild, with bulk kernels on helpers. This is separate from collector roster eligibility. Remaining foreground work is **not all O(1)**: legacy path-region maintenance, deterministic evacuation of units already on a closing tile, and navigation build allocation/prefix bookkeeping remain audit targets. Future changes should keep completion publication bounded, move derived preparation to helpers with deterministic publication, and retain rerouting/doorway-connectivity behavior rather than simply suppressing invalidation. This audit adds no gameplay changes or measured performance claim.

## 2026-10-27: multiplayer checkerboard robustness continuation

Continued the chaos multiplayer investigation rather than a TPS optimization.
The status-expiry-fixed 50k/20k mixed scene now passes 260 gameplay ticks and
command drain with helpers 7/0/3: 570 exact comparisons and zero repairs. Actual
population falls from 49,998 to 17,493 through combat; useful work and raw hashes
remain in `tests/test-runs/multiplayer-checkerboard/continued-50k.json`.

Found and fixed a separate input-loss issue: legitimate local bursts exceeded
the host's 256-action packet cap. `_localActionTick` now spills commands and
reload requeues into later unsent ticks; the host cap stays intact. The focused
three-peer regression applies all 2,310 original/requeued commands exactly once
and fails when only this fix is removed. Checkerboard packets also respect the
cap, preserve same-tick contested placements and drain the simulation backlog.

The fixture supports configurable team assignments and all 30 live-game command
handlers, including per-team dense jobs for every profession. The first WASM32
three-team/four-peer solar_system run passes under jitter/retransmission delays,
then recovers deliberately corrupted guest energy with one targeted patch and
200 subsequent exact comparisons. See `MULTIPLAYER_ROBUSTNESS_PROGRESS.md` and
`tests/MULTIPLAYER_CHECKERBOARD.md` for raw artifacts, commands and coverage
limits. Current validation targets WASM32 only per the user's clarification.
No timing speedup, p99/max improvement or gameplay hitch reduction is claimed;
remaining performance bottlenecks and profile priorities are unchanged.

Final current-target validation: WASM32 four-team islands checkerboard (18,004
actual starting units, 8,000 structures, helpers 3/0/1/2, dk=4) passes all 30
live-game handlers and delivers all 11,464 commands. It records 567 clean exact
comparisons, no unplanned repair, then one intentional targeted guest repair
and 196 further exact comparisons with no repeat patch. Host population falls
to 1,442 by tick 312; this is correctness coverage, not sustained-load timing.
Raw output: `tests/test-runs/multiplayer-checkerboard/four-teams-final32.json`.
The targeted multiplayer suite passes 10/10 across simulation modes 0/1, and
status expiry, mixed/front fixture checks and scalar/three-helper determinism
pass 3/3. No legacy memory64 tests were run after the target clarification.

## 2026-10-27: shared stationary preparation and SIMD worker brain batches

Moved ordinary turret query preparation and nearest-return-spawner decisions
from repeated foreground JS lookups to shared SoA/WASM helper batches. Details,
raw tick rows, source checkpoints and reproduction commands are in
[`tests/test-runs/stationary-brains-20261027/README.md`](tests/test-runs/stationary-brains-20261027/README.md).

Fresh baseline neighboring-tick attribution identifies the worker JS event
phase as the largest spike expansion: previous/slow/next/reference ticks
71/72/73/68 take 1301/1473/1011/1256 ms, of which events take
434/586/316/441 ms. Movement kernel 8 and four occupancy kernel 89 passes
dominate foreground kernels. All-thread CPU samples are not elapsed time.

Stationary entities publish compact descriptors on mutation; helpers resolve
owner/type/level stats, eligibility, area slices, adaptive shots and cooldown
proposals. Immutable reach lists are built on the low-priority tier, sharing
one ordered list per source and cumulative range endpoints. Longer ranges are
prepared only where entities need them, including unfinished entities. Ordinary
shot/idle commits bypass repeated JS `act()/shoot()` decisions. The initial
all-area/all-range attempts hit the entry cap and did not activate; their raw
failures remain saved, without speedup claims.

Worker batches build a compact spatial spawner index and availability masks,
then compute SIMD nearest decisions while independent route preparation runs.
Eight packed sites fit one 128-bit load; coordinate/class decoding avoids
per-site division and random tile gathers. Helper jobs own contiguous buckets
and padded count/mask rows. Result columns cost nine bytes per worker pool
record rather than per army slot. Event commits consume stamped numeric
handles; stale destroyed targets revalidate. Rules revision **42** defines
newly completed spawners as visible at the next frozen brain batch, independent
of helper timing. Full worker FSMs and projectile creation remain in JS.

Final unprofiled dk=20 pairs reverse execution order, 120 steady ticks each:

| Reference → current (ms) | Current first | Reference first |
| --- | ---: | ---: |
| Mean | 1000.0 → 837.6 | 908.6 → 842.3 |
| p95 | 1449.0 → 1163.7 | 1235.6 → 1152.5 |
| p99 | 1724.6 → 1202.5 | 1291.7 → 1240.0 |
| Maximum | 1923.2 → 1228.9 | 1328.2 → 1366.4 |
| >1500 ms ticks | 3 → 0 | 0 → 0 |

Mean improves **7.3–16.2%**, TPS **7.9–19.4%**. Both p95/p99 improve, but
the reverse-order maximum worsens **2.9%**; worst-tick improvement is mixed.
Preparation averages 58.5–59.8 → 10.1–10.3 ms; total turret phase
92.6–93.3 → 42.6–43.5 ms, events 245.9–288.6 → 220.9–222.7 ms.
All 120 steady ticks activate native preparation and consume 280,656 prepared
worker decisions per run. The isolated worker pair also reduces mean event
time 259.9 → 218.3 ms; it uses the earlier int32/four-site layout and does not
prove an independent speedup for the final packed representation.

All final dk=20 runs match hash `fbe2814e` and useful work: population
389,643–450,452 after starting at 1,000,004; 35,774 births, 100,338 deaths,
38,047 spawns (29,101 army), 7,728 research deposits, 99,909 collector
deposits, 87,566 astar deposits, 17,218 completions and 83,005 destructions.
These are not sustained-million-unit measurements. Committed/live/peak WASM
MiB changes 2230/1636/1704 → 2239/1693/1761: **+57 MiB live/peak**.
Stationary tables occupy 50,006,272 bytes, packed worker index 3,399,680,
worker record columns 2,285,568. The 3M-unit memory budget remains unmeasured.
First gameplay ticks remain roughly 15 seconds; no startup gain is claimed.

The fresh all-thread profile retains previous/slow/next/reference ticks
57/58/59/47: wall 1106.9/1612.3/979.3/920.9 ms, events
364.6/348.8/267.9/291.8, movement 288.3/284.7/289.0/272.6 and turrets
47.0/272.7/40.1/43.8. This maximum is GC-heavy: about 420 ms sampled
foreground GC, including 212 ms in turrets. The row GC observer records only
63 ms; the attribution discrepancy is retained explicitly. Movement does
not expand versus neighbors. Slow-tick kernels 8 and four occupancy passes
take 121.5 and 146.7 ms respectively; profile-window means are 113.0 and
134.6 ms. CPU profile overhead is excluded from acceptance timings.

Worker FSM/object work remains expensive every tick: `_unitWorkerEvent`
294 ms inclusive, `updateWorkerAI` 262 ms inclusive on the slow event slice,
with most helpers idle. `_findClosestSpawner` now samples about 5.7 ms self
time there. The next targets are shared worker state/transfer/builder checks,
production invalidation and route/reference handling; projectile creation,
cooldown commits, legacy path-region work and GC also remain. This is not
a complete native event-FSM migration or removal of synchronous joins.

**22/22 WASM32 validation jobs pass**: focused stationary reach/query checks
(1136/4500 per zero/three-helper configuration), worker decisions (6400 per
configuration), scalar/native tower targeting and helper determinism, boost,
storage/status/unit ABI, orders, snapshots and worker/construction regressions.
Six-map multiplayer replay compares 918 hashes/map; explicitly activated
simulation-worker harness mode compares 915/map and completes in 418 seconds.
Repairs remain inside deliberate-corruption windows. Four-team islands with
18,004 starting units, 8000 structures, helpers 3/0/1/2 and dk=4 passes all
30 actions, 567 clean exact comparisons, one intentional repair and 196
post-repair comparisons without another patch/full snapshot. Both production
variants are rebuilt: **e220cd852546b2b3 / c16dd713e614ea7d**, 107 exports.
Memory64 is rebuilt but not claimed validated; routine checks target WASM32.
Exact final source/binary SHA-256 checkpoints are in `final-source.json`.
The report-summary script's correctness-row filtering failure is retained and
fixed independently of production code.

The dk=1 cross-check **regresses overall** in both execution orders (80 steady
ticks/run). Reference → current mean is **394.5 → 408.1 ms** and
**376.3 → 388.1 ms**; p95 **487.7 → 616.1** and **463.3 → 489.3**;
p99/maximum **661.6 → 646.5** and **628.0 → 1042.8**. Thus mean is
**3.1–3.4% worse**, despite faster preparation/turrets/events. The reverse
current maximum expands mainly in projectile advancement (387.8 ms) and
action processing (132.6 ms), with row GC 51.8 ms and free physical memory
452 MiB. No matching profile establishes the exact cause. This limitation
remains explicit; the dk=20 improvement is not generalized to every TPS tier.

All dk=1 runs match hash `5e330c1`, population 461,971–722,320, 664 births,
262,095 deaths, 667 spawns (273 army), 366 research/426 collector/361 astar
deposits, 245 completions and 53,205 destructions. Each native run consumes
6791 prepared decisions; live/peak WASM is 1581/1617 MiB versus reference
1526/1561–1562. `summary.json` and `summary-regenerated.log` retain all
16 raw-run summaries and neighboring ticks. Final source hashes match the
validated checkpoint; no production edits followed the paired measurements.

## 2026-10-27: dk=1 spikes: structure row pool, native projectile flight, building limit

Details, raw rows, profiles and scripts:
[`tests/test-runs/dk1-spikes-20261027/README.md`](tests/test-runs/dk1-spikes-20261027/README.md).
Workload: 1M-unit mixed chaos at **dk=1** (real-time play), 11 helpers.

Spike slicing (previous/slow/next + same-burst reference) of a profiled dk=1
run found three distinct causes: (1) a **292 ms major GC** (worker heap
1639 → 1108 MB) landing inside `adjacencyLaneStep`; (2) structure kills from
unit hits → `destroyBuilding` → `structRowDetach` **50 ms** copying every field
of each destroyed structure into a dictionary record; (3) on input bursts, the
worker search roster rebuild `_wsGroupBuild` (114 ms). Projectile flight also
cost 58 ms mean / 187 ms max every tick (~30k live shots). dk=1 allocates
~36 MB/tick of simulation garbage (unit death detach 450 MB, projectile flight
450 MB, pending-path iterator 207 MB, structure detach 177 MB per 60 ticks).

Changes (an unused projectile object pool from the previous session was
reverted; projectiles cost time in their queries, not their allocation):

- Structure rows are a pool reserved at match start (`structTablesReserve`,
  256 MiB by class share, at most a row per tile). A destroyed structure keeps
  its row (no copy); rows expire `STRUCT_ROW_KEEP_TICKS` = 200 after
  destruction, in destroy order (deterministic), then the old object reads as
  destroyed. Full table: oldest retired row reused early; growth only with
  none retired (`structRowStats`).
- Native projectile flight (`wasm/src/proj.rs` `k_proj_flight`): one helper
  batch finds each shot's first event over the step's base ticks from the
  typed index/unit columns/tile table; JS applies events in the old order,
  re-checking targets (3,923 re-checks in 3.35M shot-steps). Equal state hash
  to the JS loop at dk=1/dk=4 and 0/3 helpers (diagnostic only: JS is legacy).
- Building limit (user request): `CONFIG_MAX_BUILDINGS` lobby setting (100k
  default) capped by each team's structure-pool share (597k per player for two
  teams on 1000×1000), per-owner counts on the tile table, placement refused
  at the limit, HUD "Bld count / limit". The chaos bench lifts the menu limit
  so its workload is unchanged.

Unprofiled dk=1 pairs, both orders, 120 steady ticks each, identical final
hash `b00f46eb` and work (population 722k → 458k, 266,732 deaths, 57,253
structures destroyed):

| Reference → current | Pair 1 (ref first) | Pair 2 (current first) |
| --- | ---: | ---: |
| Mean ms | 529 → 387 (−27%) | 481 → 444 (−8%) |
| p95 | 972 → 513 | 709 → 658 |
| p99 = max | 1263 → 995 | 957 → 791 |
| >600 ms ticks | 25 → 2 | 17 → 7 |
| >800 ms ticks | 7 → 1 | 2 → 0 |
| projectilesAdvance mean/max | 73/224 → 18/49 | 66/222 → 23/46 |
| unitHitsResolve mean/max | 36/192 → 17/56 | 33/177 → 22/152 |
| adjacencyLaneStep max (GC lands here) | 490 → 116 | 426 → 84 |
| GC ms mean/max | 9.7/76 → 8.0/62 | 10.0/65 → 9.2/81 |

Remaining (in order): movement kernel (`simMoveRun` ~115–130 ms mean, kernel
8 + occupancy 89); worker search roster rebuilds (`workerSearchTierStep` max
155–239 ms: full `_wsGroupBuild` over ~28k farms with a WeakMap write each,
needs incremental rosters); GC still ~9 ms mean / 60–80 ms max (unit death
detach records, pending-path iterators, `_tileOrderedReplaceMany`); unit
death detach should become a kept-slot pool like structures. Not yet
verified: whether the 10 structure-table growths in the bench happen in setup
or play (expiry was not exercised within 140 ticks; the unit test covers it);
per-class table shares do not follow the per-player limit exactly (a single
shared structure table would); the global startup memory budget across units,
structures and projectiles is still to be designed.

### Open issues at the end of the 2026-10-27 session

1. **Four-team checkerboard recovery diverges at 320 ticks (pre-existing).**
   `node tests/multiplayer-checkerboard-chaos.cjs --units=18000 --map=256
   --structures=8000 --dk=4 --helpers=3,0,1,2 --teams=0,1,2,3 --seed=999
   --map-type=islands --network=unstable --recover --ticks=320` (WASM64=0,
   SIM_WORKER=0) fails "repaired checkerboard stays in sync: tickHashes"
   with **66** mismatches. The pre-session sources (`baseline-state.js` +
   `baseline-projectile.js` overrides, `ft-baseline320.json`) fail
   identically (66), so it predates this session; the previous session ran
   it at 160 ticks only. After the forced guest-1 damage and its repair patch,
   all four peers match at ticks 355–360; from **tick 361** guest 1's
   **units** hash part alone differs (towers/barracks/spawners/floor/mines
   and players match). The patch restores the hashed state but leaves some
   non-hashed unit state (caches, kernel columns, path/worker/event state,
   tier/lane results) different, which changes the next tick. Next step: rerun
   with `DIVTRACE=2 DIVTRACE_TICKS=80 DIVTRACE_FROM=355` (not `--trace`,
   which keeps only 4 ticks) to name the first diverging units and fields,
   then `DIVNEAR=id,tick` for their neighbours' columns. The started trace
   run was stopped before it reported.
2. **Correction:** the first `validate.cjs` run here was reported as 19/19
   passing; the wrapper's `echo exit $?` hid the script's exit code. The
   four-team job failed in both runs (issue 1); the other 18 jobs passed,
   and the multiplayer/snapshot subset passed again on the final code
   (`validation-final.log`: multiplayer-snapshot, solo-snapshot,
   multiplayer-resync-messages, multiplayer-chaos-determinism page and
   worker).
3. **Fixed during that investigation:** structure expiry was not part of
   snapshot state. A destroyed structure still referenced by a unit is sent
   as a pooled shell; a restored peer's shell held a live row and never
   expired, while the original expired after `STRUCT_ROW_KEEP_TICKS`. Now
   tabled structures carry a `_retiredAt` snapshot key (retire tick, or -2
   once expired), restored shells re-enter the retire queue in tick order,
   and a full table grows (counted) instead of expiring the oldest row early
   (that depended on each peer's table size). Test:
   `tests/structure-row-expiry-snapshot.test.cjs`. The 1M timing pairs above
   ran before this change (it touches only destroy/restore bookkeeping); the
   four-team failure is unchanged by it (issue 1).
4. Unverified: whether the 10 structure-table growths in the 1M bench happen
   during setup or play (record `structRowStats` at the first timed tick);
   the bench never reaches expiry (200 ticks) within 140 ticks.
5. Next optimization targets (dk=1): movement kernel (~115–130 ms mean),
   worker search roster rebuild spikes (incremental `_wsGroupBuild`), unit
   death detach as a kept-slot pool like structures, remaining per-tick
   allocations (pending-path iterators, `_tileOrderedReplaceMany`), and the
   global startup memory budget across units, structures and projectiles
   (single shared structure table so per-class shares match the per-player
   building limit).

### 2026-10-28 — recovery validation and structure-pool attribution

The four-team recovery failure above is fixed. The trace corrects the old
handoff: tick 361 was the intentional 123-energy corruption; tick 406 was
the first repair-induced divergence (179 units). Full player/type stat
rebuilds updated JS values without publishing native effective rows. Restore
then refreshed only the repaired peer's native speeds. Rebuilds now publish
those rows and invalidate stat versions; rules revision is 43.

The retained 18k-unit/8k-structure four-team islands run, with helpers
3/0/1/2 and unstable transport, passes 1,054 clean exact comparisons and
197 recovery comparisons. All 14 correctness checks pass across the original
13 successes and the corrected six-map worker rerun (5,490 tick comparisons).
The worker job originally failed before executing because its preload path
was treated as a package name. The validation runner now resolves it
absolutely, retains live per-job logs and writes subset results separately.
Evidence: `tests/test-runs/desync-fix-20261028/README.md` and its linked logs.

The 240-step large mixed capture (1,000,004 initial units, 250k structures,
dk=1, 11 helpers) confirms **all 10 structure-table growths occurred before
gameplay**. Growth remains 10 at the steady boundary and after gameplay.
Expiry starts at step 200 and frees 31,370 rows by the end (51,382 retired).
The bench now records those checkpoints, per-tick counters and a direct
`structRowsExpire` phase timer.

The all-thread profile's worst steady step is 30: previous/slow/next wall
times 310/831/341 ms, versus same-burst reference step 50 at 471 ms.
Action processing expands from 65 to 256 ms; movement is 99 versus 110 ms.
The main-thread profile attributes about 319 ms to GC versus 27 ms in the
reference, although overlapping PerformanceObserver GC reports only 44
versus 19 ms: these diagnostics disagree, so do not interpret sampled GC as
an exact pause duration. At step 210, previous/slow/next are 283/640/273 ms
versus same-burst step 220 at 286 ms. Spawner processing is 138 versus 11 ms,
worker search 98 ms, with `_wsGroupBuild` about 74 ms sampled inclusive.
All 12 thread profiles and both neighborhood analyses are retained.

These are current-workload measurements, not a before/after speedup claim:
correcting stale speeds changes combat and population relative to old runs.
Serial 240-step runs (220 steady samples), retained as `pool-profile.json`
and `pool-unprofiled.json` with raw JSONL sidecars:

| Wall time / work | All-thread profile | Unprofiled |
| --- | ---: | ---: |
| Mean / p95 / p99 / max, ms | 308.8 / 437.0 / 529.9 / 830.8 | 292.5 / 427.5 / 512.9 / 622.6 |
| Ticks >500 / >833 ms | 3 / 0 | 4 / 0 |
| Measured population min–max | 424,226–579,908 | 424,226–579,908 |
| Steady births / deaths | 2,765 / 160,691 | 2,765 / 160,691 |

Both produce identical work totals: 859 research, 1,554 collector and 1,440
astar deposits; 1,032 construction completions; 2,768 spawns (1,396 army);
50,725 structures destroyed. Raw per-tick counters retain throughput.
Unprofiled expiry totals 375 ms across its 40 active ticks (9.4 ms mean),
maximum 50.9 ms at step 205, whose whole wall time is 275.3 ms. No gameplay
growth occurs in either run. Thus pool expiry is measurable but does not
explain the worst steady hitches in these captures.

Remaining targets include action bursts, worker roster rebuilds, GC and
movement; the initial gameplay tick also needs separate profiling (8.6 s in
the profile and 8.4 s unprofiled, outside the steady profile but retained in
the raw data). No production optimization was added during this continuation;
it completes recovery validation and the previously outstanding pool audit.

### 2026-10-28 — startup masking, roster reuse and bulk worker orders

Working continuation (not a zero-allocation or stable-maximum claim):

- Keep the loading overlay through four normal synchronized simulation steps,
  including multiplayer. No extra hidden simulation steps are introduced.
- Reuse worker roster arrays and pending-path lists/buckets; avoid registering
  already completed structures and redundant completion-row publication.
- Replace pending-path iteration allocations, including Map entry iteration.
- Charge bulk orders for their actual JS worker/held-unit path before taking
  the batch. Previously the native discount admitted an oversized worker batch
  and charged its expensive work only afterward. JS work now costs four budget
  units; native movement keeps its existing allowance. Rules revision is 44.

All evidence below lives in `tests/test-runs/pools-20261028/`. Serial large
mixed runs use 1,000,004 starting units, 250k structures and 11 helpers, 140
steps / 120 steady samples. Before the last Map-iteration and order-budget
edits, baseline/current p95/p99/max were 471.6/527.4/707.4 versus
455.8/555.5/564.2 ms. Reverse-order repeats were current 423.0/527.4/628.4
versus baseline 437.0/513.2/550.1 ms. Thus maximum improvement is **not
established**. All four have steady populations 431,799–579,908, 1,245 births,
151,598 deaths and identical work totals (1,248 spawns, 598 army; 433 research,
744 collector, 728 astar, 540 completions, 46,279 destroyed structures).
Repeat hashes match `b1b39307`. Raw ticks and counters accompany each JSON.

All-thread `profile.json` attributes step 30 against previous/next and a
same-burst reference: 340/661/379 ms versus reference step 20 at 417 ms.
Actions, worker search, movement and GC all expand. Allocation sampling finds
about 1,673 MiB on the simulation thread over 80 steady steps, including unit
detachment/construction, pending iterators, ordered tile indexes and owned
spawner lists. Replacing the inner pending iterator reduces the sampled total
to about 1,511 MiB (`profile-indexed.json`); remaining Map iterator allocations
motivated the subsequent static callback. The latter capture encountered severe
physical-memory pressure, so its wall timings are not a clean speed comparison.
Both captures retain all-thread profiles and neighboring-tick analyses.

The real-browser mixed-selection reproduction initially selected 45,676 units
and 1,250 houses (91,352 total units); this is much smaller than the user's
500k selected units plus several hundred thousand selected buildings. Three
ground clicks, two appended, with 11 helpers: `mixed-rally-browser-before.json`
has simulation max 210.7 ms, queued-order max 143.8 ms and applied-tick gap max
442.7 ms. `mixed-rally-browser-final.json` after the order-budget change has
simulation p95/p99/max 34.5/50.1/115.3 ms, queued-order max 54.8 ms and gap max
363.2 ms (one gap >250 ms). Page input still reaches 100 ms; presentation build
130.3 ms. All CPU profiles and raw traces are retained. This is evidence for
the small workload only; houses do not exercise actual rally assignment.

The expanded `mass-rally-500k-250k.json` requests **per player** 500k mixed units,
200k barracks and 50k builder spawners on a 2000 map. Actual placed/selected
counts must be measured; configured counts are not a successful reproduction.
Building multi-point assignment currently still runs synchronously on the page,
unlike large unit multi-point assignment. Investigate it and command admission,
transfer and simulation costs at full scale before claiming this hitch fixed.

Validation so far: `validation.json` retains nine passing checks plus the serial
benchmarks, including four-team recovery with helpers 3/0/1/2. After the order
budget edit, order-fast, action-budget, action-supersede, event-route-batch and
the new worker-budget regression pass. Final recovery validation of rules 44
and the last Map-iteration edit is still pending. Allocation/GC elimination,
full-scale rally latency and reliable gameplay maximum reduction remain open.

### 2026-10-28 — bounded rally helper submission and commits (continuation)

The requirement is stable simulation TPS: total command preparation may grow
with selection size on background helpers, but that work must not be folded
into the simulation tick. Responsiveness is secondary; pending commands may
take multiple ticks. This continuation addresses the unfinished rally path,
not all remaining simulation work.

- Large building rally assignment now uses `assign_worker.js`, including
  coordinate bucketing. Page-side packing yields every 2,048 buildings; helper
  results submit one 512-building action per task. Jobs preserve click order,
  including a later small selection, and discard old-match results. The
  existing nearest/equal-share assignment algorithm is retained.
- `setRallyMany` splits at the remaining simulation action allowance, preserving
  the uncommitted coordinates in the existing deterministic snapshot backlog.
  Rules revision is 45. This fixes commit overshoot; it does **not** remove
  arrival bookkeeping scans or make all action admission constant time.
- Finish the interrupted marker-pool work: cap building and framed-unit scans
  to 2,048 entries, reuse projected marker records, invalidate building scan
  state on reset/subgroup/command changes, and let unfinished scans advance
  without the completed-cache throttle. Other marker fallback paths and
  selection preparation still need auditing; this is not zero-allocation.

Evidence is retained in `tests/test-runs/bounded-20261028/`. The six targeted
checks pass, including helper assignment equivalence, chunk limits, click
ordering, stale-match cancellation, rally backlog restore, marker reuse,
action supersession and worker-order budgets. Four-peer unstable-network
recovery with helpers 3/0/1/2 passes 1,054 clean exact comparisons and 197
post-repair comparisons, exercising all 30 gameplay actions (`recovery.json`).

The full-scale browser fixture here corrects `editableConfig`'s embedded
`CONFIG_MAX_POP=100000` to 500000; the older fixture's requested UI population
was overridden by that value. Actual measured counts remain the acceptance
criterion. Large mixed baseline and subsequent serial measurements are
retained with raw ticks and work counters; measurement analysis follows below.

Serial mixed runs (140 steps, 120 steady, 1,000,004 starting units, 250k
structures, 11 helpers, dk=1) produced these wall times. These are broad
regression diagnostics, **not rally-setting measurements or a speedup claim**:

| Metric | Before | After |
| --- | ---: | ---: |
| p95 / p99 / max, ms | 440.3 / 531.3 / 536.4 | 515.8 / 673.1 / 718.1 |
| Ticks >500 / >833 ms | 2 / 0 | 7 / 0 |
| Steady population min–max | 431,136–579,865 | 431,102–579,881 |
| Births / deaths | 1,181 / 152,070 | 1,234 / 152,227 |
| Spawns (army) | 1,184 (587) | 1,237 (605) |
| Research / collector / astar deposits | 444 / 765 / 760 | 443 / 764 / 743 |
| Construction / destroyed structures | 540 / 46,243 | 558 / 46,286 |

Hardware/memory conditions are a substantial confound: free physical memory
at the worst ticks was only 247/264 MiB. The after run's worst step 38 has
previous/slow/next wall times 384/718/475 ms; nearby non-burst step 36 is
401 ms. Worker search expands to 359 ms versus 15 ms at steps 37/36 and
0.2 ms at 39. The before maximum instead expands in `navFieldsFlush`
(245 ms at step 126). Do not attribute this difference to rally commits.

All-thread profiling (`profile.json`, 80 steps) captures step 30 versus
same-burst reference 50: previous/slow/next 347/1,028/492 ms, reference
504 ms. `simUnitStateCollect` grows from 23 to 369 ms, actions 57 to 109 ms,
movement 115 to 140 ms and worker search 76 to 99 ms. Main-thread sampled GC
is about 379 ms on the slow tick; overlapping GC events report 111 ms, so
these diagnostics disagree on duration. Helpers are largely idle in the
expanded wall window (e.g. helper0 851 ms idle versus 377 ms at reference).
All twelve profiles and previous/slow/next/reference slicing are retained.
This supports further allocation and simulation-path work; it does not
establish a causal rally regression. The user freed memory afterward; the
remaining timing work prioritizes rally-specific browser measurements.

Rally-specific results (all files in the same evidence directory):

- `browser.json` reaches **500,000 selected units plus 250,000 selected
  buildings**, one million total units, 2000-square map, 11 helpers. Three
  ground clicks (two appended), 34.5 measured seconds, no errors. Simulation
  p95/p99/max 381.9/614.7/614.7 ms; applied gap max 1275.3 ms. A first-command
  `sanitizeAction` call takes 312.8 ms and `processActions` 364.4 ms.
- `browser-synchronous.json` restores only synchronous building assignment
  and unsplit rally commits, retaining the current marker code. It also
  reaches the full population, but **is not a controlled timing comparison**:
  the harness's temporary fixed Date was restored before asynchronous solo
  startup used it, so the armies started at different positions. Keep this
  run as diagnostic evidence, not an improvement/regression claim.
- Fix the harness by awaiting solo startup while the seed override is active,
  recording the actual seed, retaining raw tick/presentation/event rows and
  each rally submission, and recording slow sanitizer payload sizes. Optional
  source overrides allow comparisons without replacing working sources.
- `browser-profile.json` uses seed 1790000000000 and the full population for
  61.9 seconds. All **750,000** building coordinates are submitted in 1,468
  chunks, first-to-last submission **47.7 s**. This confirms submission, not
  per-building acknowledgment. No errors, no sanitizer call above 8 ms.
  Simulation p95/p99/max **465.3/486.7/494.6 ms**, applied gap p95/p99/max
  **570.9/648.3/685.3 ms**. Marker work is 1,972 ms over 4,120 calls, maximum
  **8.4 ms**; page input still reaches **878 ms** and info-panel work 442 ms.
  Profiling affects timing; do not compare this directly to unprofiled runs.

Within the final browser measurement window, traced simulation tick 56 is
slowest: previous/slow/next totals 449/498/411 ms, versus nearby action-bearing
reference tick 74 at 379 ms. Actions are 68 versus 5 ms; movement is 190 versus
240 ms, so movement does not explain this particular expansion. The worker
reports queued-order max 116 ms elsewhere. The earlier 313 ms sanitation
outlier did not recur, so it is not established as a consistent algorithmic
bottleneck. The trace also retains a 2.18-second tick during premeasurement
profiler setup (visibility 1.86 s); do not mix it into the measured window or
silently discard it. CPU profiles of the page and existing simulation/helper
workers are retained; the lazily created assignment worker is not included
in that profiler attachment set.

Remaining: stable TPS for arbitrary player bursts is **not achieved**. Work
still scales in simulation-side action arrival bookkeeping and unit-order
processing; those need bounded admission/commits and background preparation
over reusable SoA/native data. No new WASM/SIMD kernel was added in this
continuation. Full-scale pending-command latency is long, as expected from
serialized submissions; optimize it only while preserving the tick bound.
Marker fallback scans, selection/input work and the info panel also remain.
The browser's first sandbox launch failed with access-denied errors; successful
browser runs used the approved unsandboxed retry. No further mixed runs were
started after the user prioritized rally-specific testing.

### 2026-10-29 — mass commands: rally on arrival, order queue kernels, memory budget menu

Goal (user): a select-all ctrl click (hundreds of thousands of units and
buildings) must take hold within a few ticks without tick spikes; no paced
submissions or per-tick unit budgets; kernels (wasm32, SIMD, SoA) instead of
JS paths and fallbacks; tables allocated at match start, never grown in play.

Scene: `tests/chaos-spikes.bench.cjs --units=1000000 --structures=250000
--rally-mix --helpers=11 --dk=1 --kernels --burst-every=100000 --mass-at=30`
(new options: `--mass-at` issues the page's exact mass command, every unit and
rally building of team 0, three appended ctrl points two steps apart, in wire
form; `--rally-mix` makes most dense structures rally buildings; rows record
`mass`: backlog ids, queued units, buildings whose rally is not yet the last
click's). Selected: 285k units (92k workers), 72k rally buildings.
Evidence: `tests/test-runs/mass-command-20261029/`.

Changes:
- Rally: one `setRallyMany` a point, its buildings as ascending tile keys
  (`tkz`, delta varints, ~1-2 bytes a building; `src/utils/id_codec.js`, the
  codec moved there, loaded by page, worker and assign_worker). The split and
  encoding run on `assign_worker.js` (`rallyAssignTiles`), answers queued as
  they come (no 512-chunk `setTimeout` pacing: that was the 48 s). The
  simulation applies a rally whole on arrival (`_rallySetTiles`: row columns,
  rally fields are nullable Float64 `N` columns now), never budgeted or
  backlogged; presentation rally cells written directly (`simPresentRally`).
  Pending rally markers: a typed per-tile table allocated at setup.
- Move orders skip the action backlog (no arrival-mark passes) and go to the
  order queue at once; every queued order is applied within
  `ORDER_DRAIN_STEPS` (4) steps (`ORDER_NOW` 4096: small orders at once); the
  per-tick unit budgets are gone.
- Order queue kernels (`wasm/src/ord.rs`): `k_order_admit` merge-joins the
  order's sorted ids with the units in id order (SIMD skip-ahead), stamps
  `ordSq`, supersedes earlier entries (live/sum deltas), splits kernel units
  from workers; `k_order_take` takes an entry's next live slots from the ring
  straight into `k_order_move`'s list. Entries hold slots in `ord.ring`
  (sized from the settings, compacted when full; remapped on unit
  compaction); snapshots carry ids in ring order.
- Slot columns instead of id-keyed tables (ids grow without bound): `ordSq`
  (latest queued order), `actMk` (arrival marks), `idStp` (duplicate stamps);
  per-tile rally marks removed (rallies never wait). Move ids decode from
  `uidz` straight into the kernel scratch.
- Workers' move orders: the order fields by `_ordClearFast` (columns), only
  their task release in JS (`_ordWorkerManual`); the flow column branch takes
  `MANUAL_MOVE` workers.
- First-click JIT: `actionSanitizeWarm` warms admission and rally decoding on
  the match's own shapes (first click 280 -> ~50 ms of admission).
- Menu: one static population dropdown (2^3 .. 2^20 per player), power-of-two
  map sizes (16 .. 2048); the building limit (largest power of two) and the
  reservations are derived at the match's start from one 4 GiB budget
  (`data_static.js`: ~900 B a unit, ~1300 B a structure, ~400 B a tile, half
  of the rest for structures; units capped at 8 a tile, structures at the
  tiles; `memoryBudgetPop` lowers a pop that does not fit). The HUD shows the
  derived values. Probe: `tests/pop-limit-menu.browser.cjs` (Edge).
- Rules revisions 46 (rally) and 47 (queue kernels, slot stamps). wasm32 is
  the only default build (wasm64 legacy).

Measurements so far (same scene, serial):

| | HEAD (0dd3b18) | rally + deadline (JS) | + warm |
| --- | ---: | ---: | ---: |
| buildings' rally done | step 49 (19 after click 1) | click tick | click tick |
| all units ordered | > step 52 (164k left) | step 37 | step 37 |
| click tick ms | 423 | 711-767 | 569 |
| drain ticks: order ms | 8-42 | 98-131 | 30-104 |
| steady p50/p95/max ms | 291/423/472 | 313/449/767 | 313/487/569 |

Kernel-queue measurements: pending (next entry). Remaining: workers' task
release (JS, objects: `_clearWorkerTarget`, task memory) is most of the drain
ticks' order cost; it needs worker task state in columns to become a kernel.

General direction (user, 2026-10-29): convert JavaScript to Rust/wasm wherever
it makes sense, with the usual treatment (kernels, SIMD, SoA, quantized
columns, helper jobs, static tables), measuring first. Candidates noticed:
`src/game/pathfinding.js` (A*, path budgets, regions, group routes: object
JS; its own phases <1% in this scene, A* hides inside worker AI and event
fallbacks, not separately timed yet), the workers' order release, sanitize
for the remaining unit actions.

Status at the end of the session (2026-10-29):
- Fixed: worker-failure (queue buffers not in the restarted heap), MP divergences from the id join (units are swap-removed, not id-ordered: now a sorted id index, unitIdIndex), retired units dropped from queued orders at the retire pass (orderQueueUnitGone), digest drift when a targeted structure row expires (_sKeepTile / _simHEnc _hgx). Regression suite: 464/482 before these fixes; re-run pending. Passing after fixes: sim-worker-failure, multiplayer-stale-loading, multiplayer-patch, multiplayer-corruption-fuzz, action/order/rally tests, load-world, collector-farms, action-ids-codec.
- Open: multiplayer-soak fails on HEAD too (reloaded guest: a unit whose workerTarget is a gone structure decodes from the snapshot without its tile, so its digest differs; snapshot encode of gone refs, utils_snapshot.js _snapE ~1296, needs the kept tile). Kernel-queue benchmark of the 1M/250k mass command not yet run; worker task release still JS.

## 2026-10-29 (continued): serial work off the main thread, batch 1

Plan, rules and the measured inventory of serial main-thread work:
`MAIN_THREAD_SERIAL_PLAN.md` (tool: `tests/profile-serial-share.cjs` on a
`--profile` run: JavaScript self time per tick phase is serial; at ~370k
units ~200 of ~294 ms a tick).

- multiplayer-soak fixed: a gone structure's kept tile travels in snapshots
  (`_goneTile`, data_state.js); later superseded for workers' targets (below).
- Full regression suite before this batch: 482/482 (both modes).
- Rules 48: queued orders list units in id order (workers among the others).
- Batch 1a: an order's ids and a rally's tile keys decoded by a kernel
  (`k_ids_decode`, ord.rs; bytes by TextEncoder.encodeInto into the heap,
  sorted in Rust; the action cost's count too); rallies applied by
  `k_rally_tiles` over the rally classes' tables (`_ST.rtab/rrow`: each
  tile's class and row; `simRustDirect` calls a kernel on heap arrays
  without bindings). Structure table number/flag columns live in the wasm
  heap (`_sColAlloc`; `structTablesRehome` after a worker restart).
- Batch 1b (rules 49): a worker's task is columns (`wkS` packed state code,
  target-type code, target kind, material bits; `wkT` target tile or unit
  id; `wkR`, `wkN`), hashed by `k_snap_units` itself, snapshotted raw
  (`_wkTgt`), read back through the world (a gone target reads null on
  every peer). No JS digest terms for them.

Measured (same scene, serial; `tests/test-runs/mass-command-20261029/`):

| run | steady mean ms | click tick | last drain tick | click processActions |
| --- | ---: | ---: | ---: | ---: |
| kernels (before) | 306 | 448 | 385 (runQueuedOrders 115) | 43 |
| 1a | - | 490 | 336 | 17 |
| 1b | 284 (worker search 31 -> 22) | 411 | 341 (76) | - |

Next: the workers' move-order kernel (task release: reservations as a heap
table, work versions, role-memory clear; flow arm in the kernel; then no
drain), then deaths, statuses, hits, the worker brain.
- Batch 1c (rules 50): workers' move orders by `k_order_workers` (ord.rs,
  on the simulation thread, direct call): their task released (work version
  bump, reservation id table `workerReservedTiles` Int32 with heap region
  counts, the work site grid's dirty list a heap list `_wswResvList`), state
  MANUAL_MOVE, flow armed; two passes (per-profile counts, then apply) with
  each profile's destination worked out once in JS; role memory cleared at
  its first use (`rmClr`, unit.js `_unitRmApply`); pending ways flagged
  (`mvPP`) for a JS fix-up. Route fields `_routeSegEnd`, `_navReady`,
  `_awaitGroupPath`, `_idleFailVer` are heap columns (were sparse JS maps);
  the path windows' free list is a heap stack (`unit.mvFree`). Move, attack
  and rally orders no longer bump every work version of the player.
  Measured: queued orders 76-115 -> 8-18 ms a tick, click processActions 13 ms,
  steady mean 274 ms (max 328). The click tick's remaining extra is the
  worker search tier's own every-4-ticks cost (58-104 ms, serial JS), not the
  order: batch 4.
- Rule (user): no JS arrays/objects for simulation state, growing ones least
  of all; heap typed tables sized at match start, kernels; GC pauses = spikes.
- Batch 2 (deaths), in progress, not yet measured (user: convert in one go,
  sanity checks only, full perf and regression runs once no legacy JS holds
  things back): a removed unit lets go of its slot at its removal's tick
  (main.js compactRemovedUnits), no copy of its values: the object keeps a
  `SimUnitGone` record (id, owner, last position; prototype dead, energy 0).
  Pending-path units are a heap tick wheel (pathfinding.js: `ppDue`,
  `ppNext`, `ppPrev` unit columns, `_ppHead` buckets; relinked after a
  compaction, unlinked when a slot is let go); no Set/Map/list pools.
  Sanity: event-route-batch, order-fast, snapshot-pooled-structure,
  multiplayer-snapshot pass. Still JS holders of unit objects: the worker
  conflict index and healers' candidate lists (inside the worker AI: to wasm
  with the worker brain), the units list and id map.
- Batch 4 step 2 (worker brain): the collectors' target groups are built by
  `k_ws_group` (ord.rs, direct call) from the per-tile structure table `_ST`
  (code, owner, under construction, value, the stationary descriptor's type
  id), in tile order: sites as tile lists (`wsg{id}.tile`, kinds in `st`),
  spawners in tile order, bucket-sorted on typed arrays (`qgx..` -> `pgx..`,
  spawner id = its tile). No object lists (G.objs/G.types/spawnerObjs gone):
  the take resolves its results' tiles (`_wsSiteTarget`), completion
  publication checks by tile. Rebuilt when the tile table's version changes.
  Drops are not searched (none are made in play). `structTablesRehome`
  moves every `_ST` array into a restarted worker's heap. Sanity: worker,
  collector, healer, builder, research, salvager tests pass (2 updated for
  tile lists: worker-completion-publication).
- Batch 3 (structure statuses): `k_struct_status` (ord.rs, direct call, a
  table at a time: towers, floor items, barracks, spawners) ticks every
  structure in the world with a status running or no energy once a step:
  timers by simDk, tick damage, shrine income as per-owner fixed-point sums
  (integers), the watch's end (visibility cover), the energy-less listed;
  main.js removes them (floor items in tile order, towers/barracks/spawners
  from their lists' ends). The two Sets of structures, their sorted copies,
  the 512th-a-tick guard pass and every per-structure status tick are gone
  (barracks/spawners ticked at their spawn phase before: every step now).
  Damage flashes from statuses on buildings are not recorded (visual).
  Sanity: 21 status/tower/spawner/structure tests, multiplayer-snapshot and
  multiplayer-patch pass.
- Structure hits (`k_struct_hits`, ord.rs, direct call): the movement
  kernel's attacks on structures, sorted by attacker id in Rust, applied in
  that order to the structure standing at the tile (`_ST.stab`: its status
  class, `_ST.rrow` its row, both per tile): status as applyStatusEffect
  with no source type (durations from the attacker's level, tick damage from
  the hit's), immunity per structure type id (table from isEffectImmune of
  the type, made as types appear), a scout's watch (atkWatch), damage, shrine
  income (per-owner integer sums), energy and its tile copy; JS then only
  plays the first 256 hits' looks, the watches' vision cover and destroys
  (hit order). Pitfall hit: statRow is Int16 (read as i32: garbage rows, out
  of bounds), atkN is u8. Sanity: 19 hit/combat/tower/structure tests,
  multiplayer-snapshot and -patch pass.
- Batch 5 step 1 (projectiles), rules revision 51: the shots are a heap pool
  (projectile.js; pj.* columns by slot, 2^17 slots allocated once, live
  list, free stack, counts and the next shot id in pj.hdr): no Projectile
  objects, no per-step copy in and out of the kernel. A step:
  k_proj_flight (helpers, writes the shots in place), k_proj_resolve (spent
  slots freed, hit lists), k_proj_struct_hits (the structure hit of
  k_struct_hits, shared as ord.rs SCtx::hit, in shot-id order); unit hits go
  into k_hits as a third job kind (shot_hit: type statuses with their
  durations and tick damage, resistances and tower immunity from a per-type
  flags table; the blast over the unit index, its reach counted first by
  k_proj_blast so the record room never depends on thread timing). Melee
  and shot hits share hit_one (explicit timers per status, hit.rdu; sand on
  units). Nothing depends on a shot's slot: sums, shot-id order, a hash
  that is a sum (k_proj_hash), snapshot records in id order. The page's
  projectile views have their own draw prototype. Behaviour: a shot's unit
  hit lands after the movement kernel (before it earlier), a shot at a unit
  already dead that step is spent, custom-position structures are hit at
  their tile's centre, sand statuses from shots. Removed:
  projectile-structure-query.test (the JS query is gone); new
  projectile-pool.test (fire, hits, all six statuses, structure and floor
  hits, slot-free hash, restore). Sanity: 17 tower/hit/combat/structure/
  status tests, multiplayer-snapshot, -patch, -extremes, local-visual-
  snapshot, sim-frame-replica (now compares the pool with the page's views)
  pass. Measured (1M units / 250k structures, --rally-mix --helpers=11
  --dk=1 --kernels, steady ticks 20-59, ~17k shots in flight, max 25k, none
  dropped; tests/test-runs/projectile-pool-20261029/scene.json vs
  mass-command-20261029/b1d.json): projectilesAdvance 14.9 -> 3.8 ms
  (flight kernel 1.7), unitHitsResolve 21.2 -> 12.8 ms; steady mean 287 ->
  224 ms, p95 389 -> 406 (the baseline predates batches 2-3: their phases,
  simUnitStateCollect 24 -> 0.1 and spawnerStructuresTick 14.3 -> 1.6, are
  in that difference too).
- Found, not fixed (worker code, batch 4 step 4): multiplayer-corruption-
  fuzz fails in the full run ("guest2 was repaired too"), the same with no
  shots fired at all: after workerCargo on a collector, that guest's repair
  does not hold and its region by a salvager/healer diverges again patch
  after patch (each kind alone passes). Suspects: the JS worker conflict
  index and healers' candidate lists, not carried or rebuilt by a patch.
- Batch 5 step 2 (towers), rules revision 52: no JavaScript tower turns.
  k_tower_due scans the tower table's rows for the due ones (no JS wheel,
  no sort: shot ids are (tick & 1023) << 22 | tile); the prepare kernels
  answer every tower (custom stats/position from per-row heap columns tc.*;
  a reach past the table's uses the table's and asks for a deeper one;
  ownerless floor items take their cell's owner in the tile table);
  k_tower_fire (direct) takes the turns: preferred targets (now the row
  columns _ptK / _ptV; unit by id through unitIdIndex, structures by tile,
  cleared when gone or unseen by vis.cover, reach by the query's areas),
  idle cooldowns, shots into the projectile pool, cooldowns, angles (the
  presentation by tile slot). The stationary reach table is
  double-buffered (built into stb.*, switched when made); the match's first
  is made at once (414 ms at 1M/250k, in the match-start loading steps).
  Deleted: the legacy prepare, Tower.shoot/act/update and the JS structure
  searches, _towerApplyPrepared, the tile-order kernel, SIM_TOWER_* flags
  (unit per-instance resistance overrides are no longer seen by towers:
  tests only); tests tower-simd, tower-building-target,
  stationary-brain-preparation (kernel vs scalar); new
  tower-kernel-cases.test (preferred structure and unit, custom damage,
  cleared preference). Found on the way: with no units left the target
  kernels never ran (they required the unit index's slot map). Sanity: 21
  tower/structure/combat/status/MP tests, projectile-pool, multiplayer-
  snapshot, -patch, sim-frame-replica pass.
  Measured (same 1M/250k scene, steady 20-59, ~2.2k due towers a step,
  110.6k shots in 60 steps vs 111.0k before; tests/test-runs/
  projectile-pool-20261029/towers.json vs scene.json): towersTick 14.5 ->
  7.3 ms (kernels 4.8, of it k_tower_pack 2.9: every listed unit each
  step), steady mean 224 -> 199 ms, p95 406 -> 318, max 414 -> 364.
- Batch 4 step 3, first part (worker search tier), rules revision 53. By the
  profile (1M/250k scene, inclusive ms a tick): search tier 18.2 (takes
  8.8: collector exclusivity 4.3, builder/healer nearest spawner 4.3;
  collector groups 5.3, all of it k_ws_group scanning every map tile twice
  per group), unit events 11.0 (updateWorkerAI 4.9).
  - The worker conflict index (JS Map/Set of unit objects, rebuilt from
    every unit) is gone: a target's tile is exclusive by the reservation
    table alone (every target with a tile is reserved there; a healer's
    moving patient is reserved where it stood when taken: a second healer
    may take it after it moved). Manual assignment releases the table's
    holder.
  - Nearest spawner: a heap index of spawner tiles by (type, owner) in tile
    order (ord.rs k_spawner_index, from the spawner tables' rows when
    spawners come or go; reset at a restore; an answer of another type or
    owner rebuilds it once) and k_spawner_nearest (least Manhattan, then
    row, column, live energy and built). The JS per-type/owner lists, scan
    tables and near caches are gone. closest-spawner-cache.test compares
    it with a plain scan (6000 queries).
  - The collectors' groups walk a sorted candidate list (k_ws_candidates:
    floor-item and spawner rows plus the mines, LSD radix sort) instead of
    the whole map; completion publication finds a structure's rows by tile
    (binary search of the groups' tile-ordered lists; no WeakMap notes).
  - Deleted worker-target-index.test (JS index internals).
  Measured (profiled runs, steady 20-59; tests/test-runs/projectile-pool-
  20261029/workers2.json vs towers-profile.json): search tier 17.9 -> 10.1
  ms (its first-cycle spike 180 -> 5 ms), takes 8.8 -> 2.5, exclusivity
  4.3 -> 0.09; steady mean 217 -> 212, p95 377 -> 292, max 396 -> 298.
  Left in the worker brain: updateWorkerAI on worker events (5.2 ms: the
  trips), the work-site grid sweep (_wswStep 3.2 ms: flags from object
  fields, spawn queues and research levels not yet columns), the groups'
  JS bucket loops, the research-spawner object lists
  (_getWorkerSpawnersByType('research')), healers' candidate lists.
- Rule (user): integer-key sorts are LSD radix sorts by default.
- Batch 2 continued (deaths), rules revision 54: what a removed unit holds is
  let go by `k_unit_gone` (ord.rs, direct call, over the retire list's slots):
  spatial chunk / type-block / 8x8-block counts, occupancy cells (occ_release),
  visibility registration, index columns, worker work version and reservation
  (always freed now, also for a returning worker), upkeep bin, queued-order
  slots listed, population per owner, path window, statRow / movement flags.
  The detach of such a unit (simUnitStateDetachGone) no longer clears its JS
  fields (the slot's next unit starts from the defaults). Death sounds: the
  first 16 a tick. Pitfall hit: the per-radius counters overlapped owner 0's
  population counter (occupancy-grid caught it).
- Towers, barracks and spawners out of energy: the status kernel's list
  (tile order) instead of scanning all 90k barracks and 47k spawners in JS
  whenever one ran out (~1 ms a tick).
  Measured (1M/250k, profiled, steady 20-59; tests/test-runs/unit-gone-20261029/
  gone1.json vs workers2.json): deaths ~14 -> ~7 ms (kernel 2.2, JS 4.7),
  steady mean 212 -> 206 ms, p95 292 -> 253, max 298 -> 274.
  JS left in deaths (4.7 ms): the units list swap-remove and the sorted id
  index (_uix: binary search, periodic O(n) hole compaction), the id page map,
  and per death a SimUnitGone object, u._us/_si writes, owners[] null, the
  freeLater and worker-record free lists as JS arrays. All of it is the units
  list and id index being JS arrays of objects: to go with the slot list +
  heap id index (plan, batch 2 table).
  Sanity: unit-retirement, occupancy-grid, shared-spatial-determinism/-order,
  worker-walk, worker-brain-spawners, worker-completion-publication,
  order-worker-budget, area-worker-search, order-fast, event-route-batch,
  collector-farms, multiplayer-snapshot, -patch, -worker-lost, 6 structure /
  status tests pass.
- Adjacency (in progress of the convert-all batch; not yet measured): no
  per-tick cap (ADJ_APPLY_PER_TICK = 600 is gone) and no JavaScript
  fallback. Post: `k_adj_post` (ord.rs, helpers, 256-tile blocks) makes the
  whole signature grid from the per-tile structure table (signature =
  stationary type << 8 | owner: no interned JS strings), takes every dirty
  tile (the dirty set's flags/blocks are heap arrays; no takeFirst cap) and
  the cloud portals; the flood job compacts them and pairs the portals. Commit:
  `k_adj_apply` (helpers) applies every member in one pass over its row:
  stacks, levels, upgrade start (upgrademaxEnergy is a column now), stacking,
  stat-entry tokens (mTok in the heap), descriptor effective level, energy
  clamp; maxEnergy overrides are a heap column (SOverrideColumn) and object
  overrides are mirrored (_ovMx, _ovVs); per-batch tables by (owner row,
  stationary type, level). JavaScript gets only events of systems not yet
  converted (work sites, traps, vision cover, lasers). The synchronous
  recompute runs the same kernels (the JS flood and _adjApplyMember are
  deleted). MAX_THING_LEVEL capped at 63 (THING_LEVEL_CAP: the descriptor's
  6 bits). To do in the test phase: adjacency-lane-carry needs a JS
  reference copy of the old recompute as its oracle; adjacency-dirty-set
  tested takeFirst (gone).
  Adjacency measured (1M/250k, profiled, steady 20-59; unit-gone-20261029/
  adj2.json vs gone1.json): adjacencyLaneStep 11.9 -> 1.0 ms a tick, steady
  mean 206 -> 184 ms, p95 253 -> 217, max 274 -> 219. Pitfall hit first
  (adj1.json): per-batch tables filled through calculateItemStats rebuilt
  the player stat maps (research bumps the stats version nearly every
  batch): 30 s commit ticks. Now the apply kernel reads static building
  stat tables (statTablesStatic: stt.mxe / stt.vis / stt.atk by key x
  level x research level, from PRECOMPUTED_STATS_MAP, made once a stat map)
  and small per-player arrays (adj.rlv research levels, adj.bl boost
  levels, adj.rml researched maximum level; remade on the stats version).
  adjacency-lane-carry now checks the kernels against the old JavaScript
  recompute (tests/adjacency-reference.js, from git HEAD): 11,490
  buildings equal, signatures group alike.
  Next (user): the whole stat system as static [level][research level]
  tables read by kernels (per-player maps and their rebuilds go).
  Static-table version (adj3.json): adjacencyLaneStep 0.86 ms mean, 8.7 max;
  steady mean 188 ms, p95 222, max 234 (within run-to-run spread of adj2).
- Unit index prebuild: SPATIAL_INDEX_DELTA off by default. The delta build's
  apply / owner stages are single jobs; the next tick waited 13.7 ms for it
  at 1M/250k in battle, 6.1 ms for the parallel merge build (unprofiled,
  steady mean 181 -> 171 ms, p95 221 -> 215; delta.json vs nodelta.json).
  The bench takes PRE=<js> (run after setup) for such A/B switches.
- Remaining serial JS by system (1M/250k, 2026-10-29 evening), what each needs:
  - worker trips (unitEventsRun ~10 ms), structure destroy in hits/projectiles
    (~5 ms), spawner ticks, visibility (updateAllPlayerVisibility ~6 ms):
    the JS world model (grid[y][x] cell objects: 157 sites in 21 files, tile
    entity grids, structure lists) as heap tables first.
  - effective levels (~4 ms): already a kernel; left is the JS flag loop over
    the share and units with new levels (per-unit preComputed objects) and the
    EFF_BEHIND_PER_TICK cap: needs unit stats as static table rows.
  - path regions (~4 ms): the portal signature over the cloud cache each tick
    and JS floods after splits: labels from the heap wall grid (_simMoveWall)
    by a kernel, portals from the structure table (k_adj_post has them).
  - vision cover hold (~3 ms), worker search tier leftovers (~6 ms).
- Path regions in kernels (wasm/src/reg.rs): the plain labels by a parallel
  labelling of a heap wall copy (bands of rows flooded on the helpers,
  joined at band edges in one small job, made canonical in parallel: each
  region labelled by its lowest tile, whatever the bands); an owner's labels
  through its portal joins by parallel kernels (identity parents, then each
  tile's plain and owner root); the portal signature by a kernel over a heap
  list of cloud tiles reading the structure table (was a JS walk every
  tick). The wall copy follows pathRegionsTileChanged (made from the grid on
  a reset). The incremental tile hook stays JavaScript (O(1) a tile, a local
  search on closures). Labels are tile indices now: the nearest-tile cache
  key changed. path-regions-incremental and -portals pass.
  Measured (1M/250k, unprofiled, steady 20-59; reg1.json vs nodelta.json):
  pathRegionsWarm 3.4 -> 2.8 ms, steady mean 171 -> 162 ms, p95 215 -> 188,
  max 220 -> 193 (part of it run-to-run spread). What is left in
  pathRegionsWarm is not profiled yet.
- World model stage A (MAIN_THREAD_SERIAL_PLAN.md): cell type, owner and area
  are per-tile columns (map.js cellType / cellOwner / cellArea; heap arrays
  cell.type / cell.owner / cell.area where the heap is up, moved by
  structTablesRehome after a worker restart); grid[y][x] is a GridCell view
  over them (item / droppedItem still its own fields). Sanity:
  path-regions-incremental, multiplayer-snapshot, unit-retirement,
  adjacency-lane-carry, occupancy-grid pass. Found for stage B: structure
  rows are laid out per peer, so the object lists cannot simply become row
  iteration where order matters (tile order, or order-free consumers).
  clearTileEntity per destroyed structure: 8 reservation slots each looked
  up through getUnitById, the tile entity Set, render/journal notes, walls.
- Structure lists, per-tick consumers by the profile (1M/250k): researchAdvanceTick
  1.5 ms, laser links 1.3, _ownedStructureBuckets 1.0; the rest are input,
  placement checks and rare events. Research buildings' researchTask and
  isResearching are derived from the player's task now (no table fields, no
  walk over all spawners writing the task into each when it changes; the
  page's views keep their own). Research tests (5) and multiplayer-snapshot
  pass. Choice (user): order-free consumers over the tables' dense rows (SoA,
  SIMD), tile order only where order changes the result.
  The per-building writes of the research task are deleted everywhere (the
  action, the worker's research search, the building's update and its
  production refresh, the constructor). Left: the frame encoder sends each
  research building's task progress (resDone / resReq) to the page per
  structure; it should be once per player (page side, with presentation).
  _ownedStructureBuckets (1 ms) and the other object bucket lists
  (_structureBuckets, _forEachWorkInTileBox, _ownedQueueSpawners, research
  spawner lists) belong to the worker searches: to go with the worker brain
  conversion (searches as kernel scans over _ST and the structure tables,
  then the trips).
- Lasers in kernels (wasm/src/laser.rs), made every tick from the world (a
  pure function of laser tiles, owners, levels and walls; no dirty tracking):
  k_laser_scan (helpers) lists the lasers in tile order from the per-tile
  table, k_laser_build walks each laser's row and column over cellType for
  its partners and makes the beams (tile order, so the per-tile beam lists and
  float damage sums are alike on every peer) and their tiles' lists,
  k_laser_structs hits structures on beam tiles through SCtx::hit (one hit
  path; shrine, looks, destroys as the other hit kernels), k_laser_report
  turns the units' beam damage records into shrine income (first 64 looks to
  JS). connectedLasers is derived (laserPartnersOf); a laser's beam damage
  is its _lzDmg column (laserCheck; refreshed on a stats version change).
  Deleted: the JS link computation (string-keyed line maps, per-tower
  arrays, dirty rows/columns), the towers.filter for lasers each second.
  laser-links rewritten: kernel vs all-pairs reference in a real match, 60
  random layouts, 3286 lasers, 473 links equal. laser-activation,
  multiplayer-snapshot, structure-row-reuse, sim-frame-replica pass.
  Lasers, follow-up: the profile (laser1.json) showed 6.5 ms a tick: links
  rebuilt every tick, and lasers with no effectiveLevel linked at any reach
  (as the JS did: NaN limits), walking to the next wall. Now rebuilt only
  when a structure, wall, laser level/damage/construction (laserCheck) or
  the stat tables changed, and an unset effective level falls back to the
  level, else 1 (getThingEffectiveLevel; a behaviour fix). laser-links
  reference updated alike; both laser tests pass.
- Visibility cover in kernels: buildings' sight seeded with the units' run
  from the structure table (vis.rs k_vis_seed_structs, helpers, at the post:
  steps from the static stat tables at the descriptor's effective level,
  research and boosts, or the custom vision mirror _ovVs; owner and a
  watching team from the row); units' sight keys made in k_vis_snap from
  their stat rows (eff.rVsA), owner, wTeam and watch timer. Deleted: the
  buildings' registration (per-(player, area, steps) dense/sparse counts,
  rings over the area graph, the registered list, the hold queue), the JS
  sweeps over every building and every unit (1/512 a tick), the unit sight
  columns' use (vsGen/vsR/vsP1/vsP2/vsA are no longer read), the seed's
  live path. Hooks are no-ops. Behaviour: a building's sight follows within
  two cover periods (8 ticks) as units' does, no longer at once.
  New test visibility-buildings; visibility-shared-source rewritten for the
  snapshot keys; 5 visibility tests, team-watch-effects, local-visual-
  snapshot, multiplayer-snapshot and -patch pass.
  Lasers, second follow-up (user: beams only change with lasers or their
  levels): the links are rebuilt only on laser events (placed / removed:
  laserListToggle; level, damage, construction: laserCheck), the stat
  tables, or a wall set or cleared on a tile a laser's walk looked at in
  the last build (lz.walk stamps, laserWallChanged from
  simMoveTileTypeChanged); otherwise no scan and no build, only the beams'
  damage each tick. The scan (when it runs) compares 16 tile codes a SIMD
  op. laser-links also checks wall-only changes now (647 links equal).
  Visibility measured (vis2.json, unprofiled, same game state as reg1):
  updateAllPlayerVisibility 5.1 -> 2.7 ms, visCoverHoldEnd 2.9 -> 0, steady
  mean 162 -> 164 (lasers still rebuilt every tick in that run: 5 ms).
- Tile effects (user: traps and lasers are the same thing: tile-based effects
  on hostile units standing there, tick-based, tables updated by events): one
  pass a tick, tfx.rs k_tile_effects, over the effect tiles and the units the
  per-tile unit index lists on them (O(effect tiles + victims), independent
  of the unit count): trap tiles (tfx.traps) give their status (timer and
  tick damage raised to the trap's; every tick now, was on entering and once
  a second in the movement kernel, whose floor_hit keeps only mines), beam
  spans in canonical order give their damage to units (reports for shrine
  income, k_laser_report) and to structures (SCtx::hit), lasers lit by
  their beams. Laser links kept by lines (laser.rs k_laser_lines): per-row and
  per-column laser lists, each laser's partners and the beams it started;
  only lines marked by events (laser placed / removed / level /
  construction, a wall on a tile a laser's walk looked at) are worked again;
  no map scans. Beam damage every tick from the static stat tables
  (k_laser_dmg: stt.dmg by base level, damage research, boosts; custom
  towers tc.dmg), beams sorted by tile with an LSD radix sort. Trap tiles
  from the structure table by kernel on events (k_trap_tiles: kind by
  stationary type, level from the descriptor; the list in the heap), the
  status record room by kernel (k_trap_bound). Deleted: the per-tick
  all-units laser kernel use, per-tile beam lists, the JS trap refresh and
  chunk map. Left JS: the trap strength table (event: research done), the
  destroys (world model), looks and sounds.
  Measured (tfx1.json vs vis2.json, unprofiled): laserBeamsTick (lasers and
  traps now) 5.0 -> 0.78 ms; steady mean 164 -> 168 (spread). Tests:
  laser-links, laser-activation, floor-trap-kernel, floor-target,
  status-expiry-records, tower-kernel-cases, projectile-pool,
  multiplayer-snapshot pass.
- World model W1 (MAIN_THREAD_SERIAL_PLAN.md): tile entities come from the
  structure tables: per tile its table (_ST.ctab, every tabled class incl.
  mines) beside st.rrow; getTileEntityRef reads the table's row object,
  getTileEntityType derives from the code (mines) or the structure's key.
  The tileEntityRef / tileEntityType grids are lazy and hold only structures
  outside the tables (the page's views): none on the simulation side (two
  1M-entry arrays of references less for the GC to trace). All direct grid
  reads use the getters (struct classes and codes, snapshot refs and tile
  sets, worker targets, rally presentation). Sanity: 11 tests pass
  (multiplayer-snapshot, structure rows, worker-walk, lasers, adjacency,
  towers, sim-frame-replica, traps, farms).
- World model W2: _activeTileEntities is a TileEntitySet view: the tabled
  structures and mines in tile order from the per-tile table (reg.rs
  k_tile_occupied, SIMD over st.ctab, made again when the tile entities
  changed; the page without kernels: a plain pass), then the untabled (the
  page's views) kept in a Set; has() checks the tile. Iteration order is tile
  order now (was insertion order): the same on every peer, restored or not.
  Sanity: sim-frame-replica, local-visual-snapshot, multiplayer-snapshot and
  -patch, worker-walk and 9 more pass.
- Memory check (user: wasm32, 4 GiB): per-tile arrays added this session at
  2000x2000 (4M tiles). Fixed the large ones: the adjacency post's portal
  buffers were 256 slots a block (adj.cls4 64 MB + adj.cloud 48 MB): now a
  list sized by the towers' table, appended atomically, sorted by tile in
  the flood (radix); seeds as u8 offsets per block (adj.seed8, 4 MB; the
  dense list sized by the count); path region parents N + 64k (were 2N);
  the occupied-tile list sized by the structure rows; the trap tile index
  removed (linear removal on the rare trap removal). Left at a few bytes a
  tile: cell columns (24 MB; cellArea duplicates areaIdGrid's 16 MB of JS
  rows: to share), path regions ~52 MB (+32 MB per owner with portals),
  the laser tile-to-slot map (16 MB, to become a tower column), ctab 4 MB,
  laser walk marks 4 MB. To test: adjacency through cloud portals (no test
  covers it).
- World model W3: cell.item on a tabled tile comes from the structure table
  (the structure there when not a tower or a mine); the view's own field only
  for untabled tiles (the page's views, a cleared tile). Sanity: 10 tests
  pass (multiplayer-snapshot and -patch, workers, traps, farms, the page
  replica, targeting, floor targets). Measured W1-W3 together (wm1.json vs
  tfx1.json, unprofiled): steady mean 168 -> 165 ms, p95 190 -> 199 (spread),
  no phase worse. Next: W4 (the structure lists as table rows), W5 (place /
  destroy kernels).
- Spatial index re-tiling back in the movement kernel (2026-10-30). Profile
  (prof30.json, 1M/250k, steady 38-59): spatialSlotUpdate 10.3 ms and
  spatialCountsDeferEnd 8.3 ms of serial JS a tick. Cause: the epilogue
  (mv.rs epi_slot) re-tiled a unit itself only when its vision-cover
  generation matched (unit.vsGen == P[41]) or the cover was off (P[42]);
  since the cover went to the vision kernels nothing writes vsGen, so every
  tile change was listed to JavaScript (spatialSlotUpdate per unit and a
  deferred count entry each). The condition, P[41]/P[42], Epi.vis_* and the
  vsg binding (word 117 unused now) are gone; spatialSlotMove no longer calls
  the no-op cover hooks. Measured (prof31.json vs prof30.json, profiled):
  both functions gone from the profile, steady mean 196 -> 187 ms, p95
  259 -> 223, max 307 -> 228.
  Note: simParallelRun self time (10.8 ms under simMoveRun) is the
  simulation thread in Atomics.wait for the helpers' last chunks (step,
  move and four occupancy phase jobs, each with a tail): load balance, not
  JavaScript to convert. Remaining serial JS (prof31): unitHitsResolve 10.4
  (structure destroys, W5), unitEventsRun 9.4, workerSearchTierStep 6.6,
  recalculateUnitEffectiveLevel 5.2, compactRemovedUnits 2.7 +
  unitByIdRemoved 1.8 (units list and JS id index), _gameTickBody self 3.4.
  Caps still to remove: WORKER_EVENTS_PER_TICK, SPAWNS_PER_TICK,
  EFF_BEHIND_PER_TICK.
- World model W5a: structure destruction as a batch kernel. Measured first
  (prof31 journal deltas): every 4th tick ~1,600 structures die together and
  unitHitsResolve went 7 -> 25 ms (~12 us of JavaScript a destroy: lists,
  clearTileEntity hooks, structTableSet, path topology and adjacency requests
  per structure). Now structDestroyTiles(list, n) (things_utils.js) takes the
  hit kernels' dead lists, the status tick's dead and floor items (quiet:
  no explosion, sound or route change, as before) and destroyBuilding (a
  list of one); dst.rs k_struct_destroy does the tables' side in one pass in
  list order: per-tile structure table (region and per-owner counts too; rcnt
  and cnt are heap columns now), cell owner, wall cells to ground (listed),
  adjacency marks (3x3), work versions and their checksum change, the tile
  journal (a fixed TE_LOG_CAP heap ring now), mv.struct codes / classes /
  block counts, trap marks; reservations at the tiles listed. JavaScript per
  structure: the object lists (until W4), _stT and the view's item, its row,
  walk-class and wall events (nav, path regions), presentation; versions,
  adjacency request, path topology and win check once a batch.
  Measured (prof32 vs prof31, profiled): unitHitsResolve JS 10.4 -> 7.5 ms a
  tick; on the destroy ticks 17-31 -> 12-26 ms; steady mean 186.6 -> 183.4
  (p95/max worse from one helper-kernel outlier at step 29, spatialIndexRebuild
  67 ms: not this path). Left per destroy: getTileEntityRef, the stat getter
  behind baseStats in towerJoinedOrLeft (_sDerivedValue), navClassTileChanged,
  structRowDetach. Tests: structure-table, -row-reuse, -row-expiry-snapshot,
  building-limit, laser-links, adjacency-lane-carry, visibility-buildings,
  worker-walk, worker-brain-spawners, work-snapshot, floor-trap-kernel,
  floor-target, status-expiry-records, chaos-scenario-determinism (0/3
  helpers), multiplayer-snapshot pass.
- Effective levels: no cap, no selection pass (2026-10-30). EFF_BEHIND_PER_TICK
  (1,500 units behind their stat tables a tick, the rest a turn later) is
  gone with its counting kernel run: the whole share is taken each tick; a
  unit behind whose (owner, type, base level) has no base entry yet takes the
  full path once per key (that makes the entry and its row), and the kernel
  runs again for the rest of the share (parameters restored, rows counted
  again). The single-player selection refresh (new Set(selectedUnits) and a
  pass over it every tick: 185k units after the bench's mass command) is
  removed: the selection follows the share as in multiplayer. The eff kernel
  no longer registers units in the retired cover columns (P[20] -1: vsGen /
  vsR are not read; the kernel and full paths wrote them differently, which
  eff-behind-kernel caught). Measured path counts (effcount.json): 0-47 units
  a tick through the JavaScript paths; the step's time is the kernels and
  the selection pass. Tests: eff-behind-kernel, research-queue, -rebase-
  partial, building-research-keys, 7 visibility tests, team-watch-effects,
  chaos-scenario-determinism, multiplayer-snapshot pass.
- Unit id index as a heap hash table (main.js UnitIdIndex): unit slots by a
  hash of the id (linear probing, backward-shift deletes, ids read from the id
  column so a reused slot is passed over), at least twice the slots, made
  again when it fills or the slots move (relayout, restore: unitSlotMap-
  Invalidate marks it stale); slotless units (page views, hand-made test
  units) in a Map. The JS pages of 1024 references (traced by the GC) are
  gone. unit-id-index rewritten (Map path, slot path with reuse, deaths and
  a relayout against a reference).
- Worker search tier: _wsGroupBuild's counting sorts (sites into buckets,
  spawners into bucket order with per-owner counts) and _wsNearField's set
  hashes and its comparison sort (spawners by (gy, gx, id): tile order, one a
  tile, so the kernel's own order) are wsb.rs k_ws_buckets.
  Measured this batch (prof33 vs prof32, profiled, steady 20-59): mean
  183.4 -> 147.3 ms, p95 245 -> 187, max 315 -> 198 (sampled 161 -> 137 ms a
  tick on 38-59); recalculateUnitEffectiveLevel out of the top phases.
  Tests: area-search-range, area-worker-search, collector-farms, worker-*
  (6), order-worker-budget, multiplayer-worker-lost, order-fast, unit-
  retirement, slot-locality, pending-damage-restore, multiplayer-late-carry-
  restore, chaos-scenario-determinism pass.
- Unit removal: the ids' index (_uix) marks the retire pass's removed units in
  one call (uix.rs k_uix_remove: binary searches and the squeeze of holes in
  wasm; was a JS binary search per death). compactRemovedUnits no longer
  filters the whole selection every tick with deaths: only when a removed
  unit was selected (a set of the selection, made again when it changes).
- Cloud tower tables (pathfinding.js) kept by the clouds' joins and leaves
  (cloudTowerToggle from towerJoinedOrLeft), in tile order (pairs too: the
  same on every peer whatever the history); a walk of every tower (through
  the baseStats getter) only when the towers list is another. Was a walk of
  ~80k towers at every cloud join or leave (_pathRegionPortalSignature 1.3 ms
  a tick on average).
- occupancyJobs: each phase's blocks heaviest first by jobs.rs k_occ_jobs (a
  counting sort on the count's power of two; the order is load balance only)
  and the empty blocks' outputs cleared there; was a JS loop over every
  block and a typed-array sort each tick.
- Spawn queues as table columns (barrack.js): _qN the count, _qLv / _qReq /
  _qPaid the front's level, cost and payment (only the front is ever paid).
  Rule change: an entry takes the building's base level and that level's
  cost when it becomes the front (was: those of when it was queued). API:
  spawnQueueCount / Front / Pay / Push / Shift, hasSpawnQueue; a failed
  spawn no longer shifts and unshifts. spawnQueue on the objects is the
  interface's copy (getter) and takes arrays (setter: snapshots, scenes);
  the page's views keep their arrays. The frame encoder, renderer and
  digests read the count. Tests: spawner-queue-performance (slice includes
  the queue API now), starting-spawn-limits, work-snapshot, solo-snapshot,
  solo-scene-download, worker-brain-spawners, worker-approach-occupancy,
  worker-walk, closest-spawner-cache, chaos-scenario-determinism,
  multiplayer-snapshot, occupancy-grid, path-regions-portals / -incremental,
  unit-retirement, unit-id-index, order-fast pass.
- Unit id table deletes in one call (uix.rs k_uid_delete, backward shift as
  UnitIdIndex.delete): the retire pass's removed units with a slot.
- Work site grid from the tables (wsw.rs k_wsw_set, 2026-10-30): per tile the
  owned structure's work flags (build: construction, upgrade, stacking,
  repair below the maximum energy, stack candidate, upgrade due; salvage;
  queue: built, alive, queue on, front not paid; research, auto research),
  owner, area (cell.area) and reservation bits (reserver alive: the id table
  and the dead column), the per-block and per-owner counts (W.oc in the heap
  now), for a list of tiles: the journal's, the marked ones and the sweep's
  share, which is now every structure in tile order once in WSW_SWEEP steps
  (from the occupied-tile list, TileEntitySet.tileList; was the owners'
  structure buckets); mode 1: reservation bits only (changed reservation
  slots, the collectors' sites in turn). Maximum energy and researched
  maximum level from k_adj_apply's static stat tables; per class columns in
  adj.ctab and the new wsw.ctab (salvage mark, build / queue / auto research
  switches, the queue columns). Deleted: _wswFlagsOf, _wswResvOf, _wswSet,
  _wswResMax. workSiteFlagsOf(e) for tests. New test work-site-flags: 7,729
  structures in every state equal the JavaScript flags of git HEAD
  (tests/work-site-reference.js), counts too. builder-research-resume now
  places its tower and asks workSiteFlagsOf.
- _simMoveWasm: argument words 456-475 (traffic, rtEnd, controller columns,
  occupancy records) refilled only when a binding changed (_simParBinds), not
  for every chunk (their heap lookups were ~0.5 ms a tick). Words below 512 are
  the movement kernels' alone (the others start at SIM_RUST_W0 = 512).
  Measured the work site grid batch (prof35 vs prof34, profiled): steady mean
  141.7 -> 138.2 ms, p95 178 -> 168, max 191 -> 175; workerSearchTierStep
  JavaScript on the order ticks 30-34: 12.8 -> 1.3 ms. Session total (prof30
  -> prof35): steady mean 196 -> 138 ms, p95 259 -> 168, max 307 -> 175.
  Inventory of what is left: MAIN_THREAD_SERIAL_PLAN.md, "Serial JS left".
- Stage D (the worker state machine as a kernel) started (2026-10-30; plan
  MAIN_THREAD_SERIAL_PLAN.md "Stage D"). Measured first (worker-sm-20261030/
  ev1.json, --event-metrics): ~112 worker events a tick, none held by
  WORKER_EVENTS_PER_TICK, 3.9 ms of JavaScript a tick under _unitWorkerEvent.
  D1 (worker state as columns): the workers' role memory (spawners, pins,
  mines, queue commits, last work sites, trip costs, recheck ticks: ~45
  fields, objects by reference) and carryingValue are worker-record columns
  now (sim_unit_state.js SIM_WK_MEM: targets as wkT's tile * 8 + kind, types
  shared, a column's first name its snapshot key; unit.js accessors by the
  old names; the collector memory object is a view of them). carryingValue
  left the object digest: the hash kernel takes it from the record (k.rs
  k_snap_units term 36). The order kernel clears a worker's task memory
  itself (ord.rs wm_clear); the pending role-memory clear (rmClr,
  _unitRmApply) is gone.
  D2/D3 started: wasm/src/wai.rs k_worker_ai, one serial pass over the
  tick's worker events after the others (unit.js unitEventsRun lists them;
  floor items first, as before), in their order: the event glue
  (_unitWorkerEvent: AI, command sync, way end, a second look when the way
  just ended, arming: flow arm on the atlas, work and idle parks with the
  idle search's version and backoff), reservations with their region counts
  and sums and the work grid's marks, work versions and their checksum, the
  idle search schedule (shouldRunWorkerIdleRetarget, _workerWorkHash), the
  search tier's registration (wsRegister + _wsWait), payments appended to the
  resource batch's heap rows, the energy log as per-tick sums. Out events
  (worker.js waiOutEvents, in order): sounds, the research queue's advance,
  arming off the atlas or with its own stats, and the events of types not
  converted yet (their JavaScript, unchanged). Stats from the effective rows
  (eff.hot words 11-15: builder / healer / researcher dps, gather a trip,
  transfer cooldown ticks); per owner and level tables for the research
  building's efficiency and dps and the workers' search ranges (worker.js
  _waiTables, by the stat tables' version). _idleFailUntil is a worker
  record column now (wmFailU). The transfer cooldown is a Uint16 timer with
  tmOn (as its setter).
  Researchers converted (their JavaScript gone: updateWorkerAI's branch,
  _researcherDeposit). Rule change: a research building with no active task
  starts the queue's next one at once for the pass (its words), the queue's
  own advance (tryAdvancePlayerResearchTask) after the pass. The benches
  count research deposits from the kernel (_wai.researchDeposits).
  Tests: worker-walk, builder-research-resume, research-queue (multiplayer,
  fuzz seeds in sync), research-rebase-partial, building-research-keys,
  work-snapshot, multiplayer-snapshot, solo-snapshot, worker-brain-spawners,
  worker-completion-publication, worker-created-start, chaos-scenario-
  determinism (0 and 3 helpers) pass.
  Salvagers converted (updateWorkerAI's branch gone): marked and owned
  (their reservation's holder alive by the id table), the refund (price by
  stationary type, stacks from the class tables, the salvager's level), the
  destroy as an out event (destroyBuilding after the pass), the trip back to
  the worker brain's nearest yard of the tick (a stale answer: none), the
  payment and log. Per profile walls (builders and salvagers walk their
  owner's class walls) and atlas bits for every profile; class columns by
  table (wai.ctab, WAI_CTAB_COLS). Tests: worker-walk, worker-brain-spawners,
  work-snapshot, multiplayer-scenarios, multiplayer-ran-once, research-queue
  pass.
  Collectors (energy and A*), healers and builders converted too: every
  worker type's branch of updateWorkerAI is gone; it keeps only MANUAL_MOVE
  (declined events: manual moves, pending ways, shooters). Collectors: pins,
  gather (farm multiplier tables per owner / resource / level; mine takes as
  out events: the value, an emptied mine to ground), returns to the
  preferred or nearest dropoff (the worker brain, now run for any number of
  events), deposits on the batch rows (A* log as an out event). Healers:
  queue commits and pins, queue payment in the class columns (production and
  ready order as an out event), unit heals by the id table (energy and maxE
  columns, positions x0/y0 in the pass), trips to healer spawners. Builders:
  the watchdog and recheck, sites / upgrades / stacking / repairs from the
  class columns and the static stat tables (as k_wsw_set), candidates'
  starts and completions as out events (things_utils.js's completions),
  BUILDING_IN_PLACE's trickle, gold trips. Worker memory columns for all
  types; workers without a shared stat row get their own stat words before
  the pass (_waiOwnStats: a joining peer's restored units have none, which
  diverged multiplayer-snapshot). The unit id table is made when missing.
  simRustDirect now copies P's whole length into the argument block's 512
  doubles (was the first 64: params past them were dropped silently, which
  broke the collectors' and builders' params twice); a P longer than the
  block throws. waiStepUnit(u): one worker's event through the kernel
  (tests). worker-walk's mine cluster uses GoldMine / AstarMine (plain
  objects are not in the structure tables).
  Measured (prof36, 1M/250k, profiled, steps 38-59): the pass 0.3 ms
  JavaScript + 1.2 ms wasm a tick; declined events' JavaScript 0.2 ms; out
  events 4.8 ms (mostly construction completions: the builders now finish
  ~1,300 sites in 22 ticks where HEAD's ~21; healers paid ~950 spawns where
  HEAD's ~28: HEAD's workers sat parked mid-task in this scene, e.g. 8k
  salvagers MOVING_TO without a way). Steady mean 132 ms, p95 202 (prof35
  138 / 168), not comparable as gameplay: the scene's work changed a lot.
  Open: research deposits 0 in that window (HEAD 10-36): check researchers
  at scale; collector-farms (vm test of the deleted JavaScript) to rewrite
  as a match test. Tests: worker-walk, worker-approach-occupancy (now through
  waiStepUnit), builder-research-resume, worker-fallback-upgrade,
  worker-completion-publication, worker-created-start, worker-brain-spawners,
  research-queue, research-rebase-partial, building-research-keys,
  multiplayer-snapshot, multiplayer-scenarios, multiplayer-ran-once,
  multiplayer-worker-lost, work-snapshot, solo-snapshot, area-worker-search,
  order-worker-budget, chaos-scenario-determinism (0 / 3 helpers) pass.
# Memory investigation (2026-10-30)

Continued the failed 1M mixed-worker run. Raw measurements and the modified
files' pre-change copies are in `tests/test-runs/memory-20261030/`.

Found and fixed:

- `simUnitPopulationSlots` had effectively replaced its 512 MiB speculative
  column budget with almost the entire 4 GiB match budget. Slot-sized scratch
  then multiplied the unused reservation. Restore the 512 MiB limit;
  `simUnitStateReserve` still allocates all required starting/restore slots.
- Every combat unit's constructor assigned `_idleFailUntil = 0`, allocating
  a full worker record because its new column default was NaN. Make zero the
  implicit and initialized default of that timer. Nonzero and explicitly
  undefined values still round-trip. Combat units no longer take worker rows.
- `navAtlasHeader` validated addresses after storing them in signed Int32
  words. Valid addresses above 2 GiB looked negative, disabling atlases and
  allocating large destination-field fallback pools. Validate the original
  heap addresses, then encode the ABI words. Invalid/outside-heap arrays are
  still rejected. All five in-use profiles retain their atlases in the
  million-unit run; destination-field storage stays at 11.625 MiB.
- Portal-signature invalidation discarded both per-owner path-region arrays
  rather than using the existing rebuild-in-place path. Allocation attribution
  showed 181.5 MiB there by step 239, although only two owners needed buffers.
  Mark entries dirty and reuse their labels/parents. Random portal/wall edits
  still produce the reference connectivity partitions.
- Cap percentage-based speculative WASM growth/headroom at 64 MiB. Explicit
  expected allocations and twice the recent largest allocation can still
  request more. The helper-growth regression retains zero main-thread grows.

Added `--memory-stats` to the chaos benchmark, worker record counts to
`simMemoryStats`, and RSS/external/ArrayBuffer metrics to `--system-metrics`.
These distinguish WASM capacity, live allocator bytes, and whole-process RSS.

Serial mixed-chaos measurements (1,000,004 starting units, 250,000 structures,
1000x1000, 11 helpers, dk=1, rally mix, mass order at step 30):

| Run | Completed ticks | Peak live WASM MiB | WASM capacity MiB | Final live MiB |
| --- | ---: | ---: | ---: | ---: |
| `baseline.json.jsonl` (allocation attribution) | 14, then helper failure | 3724 | 4096 | 3091 |
| `reduced.json` (reservation, worker records, atlas fix) | 240 | 2006 | 2560 | 1964 |
| `final.json` (also portal buffer reuse) | 240 | 1896 | 2349 | 1855 |
| `bounded-growth.json` (all changes) | 240 | 1896 | 2018 | 1855 |

The final implementation cuts peak live allocation by 49.1% and WASM
capacity by 50.7%, completing a longer run without the baseline's exhaustion.
Near one million survivors (step 2: 959,181 units) it holds 1,809 MiB live in
a 1,954 MiB heap. This is **not** a 1 GiB total-process result: RSS is 2,554
MiB then and peaks at 2,888 MiB, including the harness, JS objects, helper
threads and other buffers. The mixed fixture is also not a sustained-million
population test: steady measured population is 241,720–435,245; steady births
10,112, deaths 205,490. Whole-run work: 10,468 births (10,396 army), 145
research deposits, 6,968 energy and 6,147 A* deposits, 4,174 construction
completions, 23,135 structures destroyed. Work/population match before and
after the portal/headroom changes exactly.

Final steady wall p95/p99/max: 195.2 / 237.3 / 473.7 ms; 0 ticks over 500 ms,
8 over 1.5x median. Before the headroom cap: 202.6 / 254.7 / 431.0 ms, also
0 over 500 ms. These single runs do not establish a TPS improvement.
The worst final tick is step 200: previous / slow / next / nearby normal
wall times 107.9 / 473.7 / 125.3 / 112.7 ms (steps 199/200/201/203, all
without player bursts). `structRowsExpire` expands from 0.012 to 339.9 ms;
movement stays 66.1 / 64.3 ms. GC overlap is 8.1 ms on the slow tick.
This is phase attribution only, not a new CPU-profile investigation; the
structure-expiry hitch remains outside this memory change's scope.

Remaining costs: 1,204,224 reserved unit slots, 475 schema bytes/slot;
unit-bound arrays including side records total 614.8 MiB. Navigation bindings
144.1 MiB, acquisition 110.9, adjacency 70.0, movement scratch 64.3, lasers
49.9, stationary reach 44.2 MiB. These are binding groups, not an exhaustive
allocation inventory (some memory is unbound or in JS). Further reductions
toward 1 GiB require smaller unit/scratch representations and less retained
JS state, beyond correcting the allocation mistakes above.

Secondary combat fixture (`combat-million.json`): 1,000,000 starting units,
31,251 towers, 1000x1000, 11 helpers, dk=1, 20 warmup + 60 measured ticks.
Setup is 844 MiB live / 998 MiB capacity; gameplay reaches 1,514 MiB live /
1,638 MiB capacity. Final RSS 1,988 MiB, JS heap 422 MiB. Actual measured
population 746,674–964,852 (final 746,674), no worker economy; occupancy audit
passes with zero position mismatches. p95/p99/max tick time 144.1 / 200.4 /
200.4 ms, no measured ticks over 500 ms. Raw rows retained. The older
checkerboard fixture's empty starters failed startup with unbound stationary
tables; it now explicitly starts one king and house per team, as its existing
comment intended, and only invokes `updateStats` on entities implementing it.
This is a secondary measurement, not a historical checkerboard timing A/B.

Reproduce the final mixed run:

```powershell
node --max-old-space-size=8192 tests/chaos-spikes.bench.cjs --units=1000000 --structures=250000 --rally-mix --helpers=11 --dk=1 --kernels --system-metrics --memory-stats --burst-every=100000 --mass-at=30 --ticks=240 --out=tests/test-runs/memory-20261030/bounded-growth.json
```

Validation: memory-allocation-regressions, heap-full-reserve, storage-abi,
worker-walk, work-snapshot, multiplayer-snapshot, nav-atlas, path-regions-portals,
path-regions-incremental, heap-grow-ahead, helper-heap-binding pass. Mixed
chaos deterministic replay matches all 65 hashes with 0, 0 and 3 helpers,
including after the portal reuse change. No Rust ABI change or rebuild needed.


# JS -> wasm conversions, continued (2026-10-30, later session)

User: convert the remaining JavaScript first; full testing and benchmarks
after (no TPS measuring between conversions). Baseline profile before this
batch (1M/250k mixed chaos, 0.5 ms sampling, steps 38-59):
`tests/test-runs/conv-20261030b/base2.json` (+ .cpuprofile): main thread
~103 ms wasm, ~40 ms JavaScript, ~9 ms waits a tick; the JavaScript is flat
(largest: deaths' bookkeeping ~3.7 ms, structure destroys' object side
~2.5, effective levels ~3.1, spawning ~3.4, tile wall changes ~3).

- Effective levels: units catching up with new stat tables (flags 5/6,
  after every research) no longer get object writes in JavaScript. Their
  base tables are a row (new movement column `bsRow`, Int16; rows
  `_effBRowObj`, per base entry `eff.bRow`, noted by `_effBaseNote`, reset
  past 32k rows with every holder keeping its object), and `maxEnergy` is
  stored in the heap column `jMaxE` (SIM_UNIT_JS_COL_ALIAS); k_eff_units
  writes both. Unit's preComputedBase / basePreComputed read the row
  (setting either makes both the unit's own). `_effBaseIndex` no longer
  allocates. Tests: eff-behind-kernel, shared-stat-rows, storage-abi,
  research-queue, multiplayer-snapshot pass.
- Tile changes (walls, walk-class walls, step costs, block change counts,
  navigation diff counts) as one batch kernel: wasm/src/tch.rs
  k_tile_changes over a queue (t * 2 + kind) flushed at once outside the
  unit pass and at its end inside it (unit.js simTileChangesFlush; the
  destroy batch flushes once). Deleted: navClassTileChanged,
  navWallChanged, _navDiffChanged, stepCostsChanged, _simMoveWallBlk9Add,
  the JS wall / class queues. `_navDiff` and `_stepCost` live in the heap.
  Units on new walls are still pushed off in JavaScript (_simWallPushOut).
- Path regions' tile hook as a kernel: tch.rs k_reg_tiles (the union-find
  join / split check / windowed search of pathRegionsTileChanged, per kept
  label set), run at the same flush. Behaviour change: inside the unit pass
  the labels now follow wall changes at the pass's end (as the movement
  walls do), not at once. Deleted: pathRegionsTileChanged,
  _pathRegionTileSet, _pathRegionJoinedAround. Tests: path-regions-
  incremental (same rebuild counts), path-regions-portals, nav-* wall
  tests, worker-walk, chaos-scenario-determinism (0/0/3 helpers) pass.
- Destination fields by key: the pools' JS Maps (byKey) are open-addressing
  tables in the heap (flownav.js _navHt*, key / slot + 1 pairs, the same hash
  as Rust); the staggered sweep's marks and the cycle end's drops are
  kernels (wasm/src/nfs.rs k_nav_sweep_mark / k_nav_sweep_drop; drops in
  slot order now, was the Map's insertion order: deterministic either way).
  navFieldsLive(F) counts a pool's fields. tests/nav-field-sweep.test.cjs
  rewritten to drive the kernels in a game instance against the Map
  reference; nav-field-sweep.bench.cjs (timed the deleted JS) removed.
- Snapshot copies to the helpers: the healer candidates' six column copies
  (_hcPost) and the acquisition tier's hostile / structure / cover copies
  (_acqPost) go through one simParallelCopyHeap each.
- Visibility cover commit (renderer.js _visCoverUnitsCommit) as nfs.rs
  k_vis_commit: counts, visible bytes and the visual rows' tiles (an area ->
  tiles table in the heap, _visAreaTiles); rows outside the heap are dropped
  and made again from the cover when asked for.
- Movement charges' per-chunk sums (k_charge_sum) and the status pre-pass's
  shrine shares per owner (k_owner_sum) as kernels.
- Left as JavaScript on purpose: the adjacency commit's area loop (areas are
  plain objects cloned into snapshots; making active / multiplierLevel
  columns changes the snapshot format: ~0.4 ms, later), the hits' looks
  (presentation).
Tests: nav-field-sweep, nav-atlas, nav-background, nav-rows,
nav-shared-build, visibility-buildings / shared-source / source-mask /
range-collision, shrine, status-expiry-records, chaos-scenario-determinism
(0/0/3 helpers) pass.
- Stage U, step 2 (retire pass): the per-death decisions are a kernel
  (nfs.rs k_retire_plan, after the retire kernel's lists, in their order):
  the gone list (slot, ~slot for removeUnitNow's), the death sounds (the
  first UNIT_DEATH_SOUNDS non-worker, non-king deaths: wkS, spType) and a
  king's death (spType = the king's spatial type; an own isKing override is
  no longer seen by the retire pass). `_removedNow` is the heap column
  jRmNow (SIM_UNIT_JS_COL_ALIAS). JavaScript keeps the list moves (units /
  slot map swap-removes, no object read), the selection check (only with a
  selection), the units without a slot, and the detach (SimUnitGone). The id
  table and the ids' index take the removed by slot
  (UnitIdIndex.deleteSlots, _unitByIdRemovedSlots). Not done: lazy detach
  (dead units would stay in owners[], which many passes read as live).
  Tests: unit-retirement, multiplayer-snapshot, worker-walk,
  multiplayer-features (kill-king victory on every peer),
  chaos-scenario-determinism (0/0/3 helpers) pass.
- Slot zeroing off the spawn path: slots let go this tick are reset to a
  fresh slot's state in one parallel job when they are released (start of
  the next tick, simUnitStateReleaseFreed -> SIM_KERNEL_SLOT_ZERO, nfs.rs
  k_slot_zero over a column table: every unit and movement column zero,
  sepKey absent, sepLayer zero) and marked unused, so taking one clears
  nothing (the generated _simSlotZero over ~225 columns was 0.49 ms a tick
  of the Unit constructor's 1.67 in base2). Status records still held are
  let go before. The tick-start copy (sepD0 / sepR0 / sepL0) writes free
  slots too: cleared when a slot is taken. Checked: freed slots read all
  zero (but that copy) and unused before reuse; unit-retirement,
  storage-abi, multiplayer-snapshot, chaos-scenario-determinism pass.
- Spawning, measured in base2 (hundreds of births a tick in steps 38-59):
  the Unit object itself is cheap (constructor self 0.14 ms); the cost was
  column initialisation (above), level scaling 0.18, the queue's front
  stat lookup 0.49 (spawnQueueShift -> getUnitStatForOwner), rally
  templates ~0.3. So Stage U's "births without objects" is worth less than
  planned; the structure side (completions, destroys) is the larger JS.
- Wall push-out as a kernel: units on tiles that just became walls (1.37 ms
  a tick in base2 under unitPassEnd: a forEachUnitInRange per new wall)
  found by tch.rs k_wall_units over the spatial index (the same candidate
  chunks, stamps, ranges and tests, each tile's in id order); JavaScript
  pushes only those found (pushUnitOutOfBlockedTile). isFlying is the heap
  column jFly (alias); _unitNoWayCommit read the old j_isFlying column
  directly (fixed).
- Construction completions: the second refreshThingProgressState after
  markConstructionComplete (which already ran it) dropped. The rest of the
  completion stays JavaScript for now: the level / construction setters
  feed the derived-stat tokens, brain words, work-site groups, upkeep and
  laser links; a kernel must replicate all of them (planned with the
  structure object model, W4).
- Pre-existing failure noticed: tests/laser-links-incremental.test.cjs
  reads _laserMap.beams, which the committed laser kernel code no longer
  has (fails on HEAD's sources too; to fix with the test pass).
Tests: construction-walk-driveby, floor-trap-kernel, adjacency-lane-carry,
storage-abi, chaos-scenario-determinism (0/0/3) pass.

## Regression pass (2026-10-30, mode 0): 18 failures, fixing all
Results: tests/test-runs/conv-20261030b/reg-mode0.json. Fixed (each re-run passes):
heap-full-reserve, spatial-index-empty, unit-hidden-class (slot map / retire
counts / cell columns kept in the heap; simRustDirect says "missing heap
arrays"), pathfinding-routing (vm stand-ins), unit-collection-blocks and
shared-unit-state (detached units read dead / no energy / only id, owner,
position: tests updated), adjacency-dirty-set (takenAll), index-delta
(SPATIAL_INDEX_DELTA on in the test), unit-animations (kernel sound table),
laser-links-incremental (heap beam tables), collector-farms (rewritten as a
match test against the worker kernel), battle-performance (reservation
invariant), multiplayer-patch: two real desyncs fixed:
 - k_proj_struct_hits ran P[0] = 256 stale hit entries (projectile.js
   _projStructHits never set its count): extra hits that differed by peer.
 - stationary type ids by first appearance (differed after a restore):
   seeded in a fixed order (data_state.js _stationaryTypesSeed).
 - worker memory references to shells without a tile yet during a decode:
   set again at the decode's end (unit.js _wmDecoded).
Still failing (to continue): multiplayer-host-migration (the reloaded host
diverges ~50-100 ticks after rejoining: unit 1 registered in the search tier
(wsKind 3, wkIdle 1) on it, RETURNING_FOR_GOLD on the others; reservations
equal; first hash part "globals". wsFail now cleared at the tier reset on
every peer; wkIdle and other per-slot tier state not in snapshots are the
next suspects; probes: scratchpad hm_probe / hashdiff), multiplayer-
corruption-fuzz, multiplayer-scale-interactions, sim-worker-failure
(SIM_KERNEL_VIS_SEED_STRUCTS before the structure table is in the heap).
Then: mode-1 (SIM_WORKER=1) suite, then the 1M/250k benchmark.

# Stage E conversions (2026-10-30, session 3)

User: convert Stage E and the remaining JavaScript first; regression,
multiplayer fixes and benchmarks only after (a regression run started
mid-conversion was stopped on request). Baseline profile before this batch:
`tests/test-runs/stage-e-20261030/cur.json` (1M/250k mixed chaos, steps
38-59: ~185 ms a tick sampled, ~110 wasm; of the JS, ~19 ms is the main
thread waiting in simParallelRun, not serial work).

- Structure destroys: dst.rs k_struct_destroy retires the rows itself (the
  class tables' retire queues ret / rt / rp / rn and their head words qhdr
  are heap columns now, data_state.js _sTableOf / _sTableGrow), writes
  _stT = -1, hands back (class code, row) and the destroyed tiles (deadOnly:
  val <= 0 in the kernel). JavaScript: the cells' _item, tile-change queue,
  walls, cloud / laser towers' toggles, presentation (from the tile, no
  object). No getTileEntityRef, structRowDetach or list removal per tile.
- Stage E step 1: towers / barracks / collectorSpawners are views of the
  per-tile structure table in tile order (data_state.js structListView over
  _activeTileEntities.tileList(), refilled when the kind's membership version
  moved: structTableSet and the destroy batch bump it); the names are Proxies
  (lexical bindings: the harness and the browser both see them) standing for
  the current view array; whole-list assignments became structListsReplaced()
  (reset, restore); the page of a simulation worker keeps its own view lists
  (structListsSetView). Deleted: structListPush / structListRemove, the `_li`
  column. isTeamAliveByAssets reads the table's per-owner count
  (playerStructureCount), a cloud placement check the cloud set
  (pathfinding.js cloudTowerOwned): no list walk per tick. Order change: the
  lists are in tile order (was placement order with swap-removes) on every
  peer whatever the history; hashes already sorted by tile.
- Stage E step 2 (completions): construction done, upgrade done, stack made,
  site maxEnergy, refreshThingProgressState and beginUpgradeProgress are
  kernel functions on the class columns (wai.rs p_complete / p_upgraded /
  p_refresh / p_begin / p_maxe_set, p_tok: the derived-stat tokens and the
  descriptor word's levels), run inside the builders' pass where they happen
  (not after it) and from JavaScript through the worker kernel's mode 2
  (things_utils.js structProgressOps). The JS versions of those functions are
  wrappers; the completion's other hooks (wall sync, work sites, traps,
  upkeep, spawner production, laser check, label) stay JS
  (structCompleteHooks). Behaviour change: a builder's start / completion is
  visible to later events of the same pass (was: after the pass).
- getTileEntityRef: the class table by class code from an array (was a Map).
- sim-worker-failure: SIM_KERNEL_VIS_SEED_STRUCTS ran before the structure
  table was in the heap on a page whose worker failed (rehomed first).
Tests (sanity only): structure-table, structure-row-*, building-limit,
laser-links, visibility-buildings, worker-brain-spawners, builder-research-
resume, construction-walk-driveby, collector-farms, worker-walk,
work-site-flags, adjacency-lane-carry, chaos-scenario-determinism pass.
- Stage E step 3 (units by the id table): main.js _uix (ids ascending,
  slots; heap) is the units' store and order: unitAdded (births, splits,
  restores), unitRemoved, holes from the retire kernel's k_uix_remove
  squeezed by unitRows() (P[1] force) before a pass reads the rows.
  `units` (data_state.js) is a lexical Proxy: its length the count (no
  view made), elements / iteration through unitsView() (objects by row,
  made again when the table changed); push / pop / splice / length = n act
  on the table; whole-list assignments are unitsReplaced (reset, restore:
  _uixFromList) and unitsSetView (the page of a simulation worker). The
  kernels' ix.slots is the table's slots (_unitSlotMapEnsure); the retire
  pass moves no list. Caches that keyed on the units array's identity use
  the table's epoch (simUnitStateCollect, the ids' map). Order change: the
  simulation's unit order is id order (was insertion with swap-removes).
  At 200k units no per-tick pass makes the view (the effective levels'
  stride reads rows: unitAtRow).
- Births: fresh slots' defaults also after a compaction (its new state's
  free slots were zero: a new unit there had cmT / cwTick / hObj 0 on one
  peer only: an MP hash mismatch). Never default live / tmOn on free slots.
  The Unit constructor's prepare(u) runs the role setup (worker config,
  starter defaults) before its one level scaling, as the old order had it.
- Bug fixed (pre-existing, found here): tfx.rs k_tile_effects read the
  Int16 upT column as i32; trap statuses applied only while the next slot's
  type index was 0 (fresh slots' default -1 exposed it: no trap applied).
Tests (sanity): worker-walk, spatial-index-empty, solo-snapshot,
unit-retirement, multiplayer-snapshot, multiplayer-features, floor-trap-
kernel, chaos-scenario-determinism, structure-table, laser-links,
collector-farms, storage-abi pass; mode 1: multiplayer-snapshot,
structure-table, sim-frame-replica, unit-retirement, chaos-scenario-
determinism pass.
- Retire pass as its own function (_unitRetirePass; pendingPathsTick too:
  phases for the bench). The removed units' id-table entries are marked by
  their rows (the retire kernel's order gives them), no binary search per
  death (_unitByIdRemovedRows; deleted _unitByIdRemovedSlots).
- Slot reset kernel (k_slot_zero, SIM_KERNEL_SLOT_ZERO): jobs of n / 64
  slots (were 256: a slot touches ~225 columns' cache lines, one helper
  took ~6 ms at 2,500 deaths a tick; the wall time was one job's).
- Salvage destroys of a worker pass in one destroy batch (waiOutEvents).
Measured (1M/250k mixed chaos, steps 38-59, unprofiled, ph3.json, before the
last three items): tick ~172 ms; _unitRetirePass 4.8 (gone kernel 1.9, id
removals 0.9), births 3.3, waiOutEvents 2.5, structDestroyTiles 2.3,
pendingPathsTick 1.2, slot reset 6.8 (kernel). Profiled (cur2.json): JS left
per phase: movement glue 9.5 (mostly helper waits), tick body 9, unit events
7.4, hits 5.4, projectiles 3.1, towers 3.0 (waits), births 2.7.

# Stabilization after Stage E (2026-10-30)

User: fix every failing test before converting more (MAIN_THREAD_SERIAL_PLAN.md
"Paused"). Fixes:
- Per-tile energy copy (_ST.val) lagging the class tables' _en: ord.rs
  k_struct_status (burn / poison / ice damage) wrote _en only. Every peer
  lagged alike until a patch wrote energy through the setter on one guest:
  that region's hash (the core sweep reads val) then differed every ~40
  ticks and patches could not fix it (val is not snapshot state). Kernels
  read val too (tower due, worker groups, nearest spawner, laser lines). The
  kernel now writes val by _stT. Same cause as dst.rs k_struct_destroy's
  dead-only test (now the class table's energy column). Found with the
  corruption fuzz (multiplayer-corruption-fuzz: buildingLevel on a guest,
  repaired; the rng kind's patch count then saw that guest repaired again).
- Host migration: matchStartConfig (map size and settings) was set only on
  the host that started the match; a guest that took over sent joiners a
  match without cfg, so a reloaded player made its grid at the page's 80x80
  and took the 20x20 size from the snapshot after: its cell columns (area,
  type, owner) read other tiles; the work site grid's areas differed and a
  worker search committed differently ~45 ticks after the join. Guests keep
  the cfg of their match start (utils_networking.js).
- Eight-team start: the first adjacency pass ran before any structure made
  the per-tile table (guests of a match without structures yet): data_state.js
  structTableEnsure (the sizing, also used by structTableSet).
- Tests updated for units / structure lists as views (unitsSetView,
  structListsSetView, structLiveRows): shared-stat-rows, research-menu,
  spawner-queue-performance, nav-field-sweep, building-research-keys;
  deltatick-multiplayer compares from when the repairs settled.
Results: mode 0 236/241 before these, the 5 then fixed (targeted re-run
18/18: tests/reg-20261030-m0-targeted.json); corruption fuzz also with
SNAP_KERNEL_MIN=0. Mode 1 (SIM_WORKER=1): 241/241 (tests/reg-20261030-m1.json).
Probes: tests/_probe_cf.cjs (corruption fuzz with the host's differing
regions per request and a region's per-tick hash inputs), tests/_probe_hm.cjs
(host migration: every worker's columns, _ST / work site grid digests by
tick), tests/_probe_rj.cjs (one instance: flush-only vs restored, alike).

## 2026-10-30: multiplayer audit fixes, then chaos dk=1 spikes (structure expiry, command bursts)

Multiplayer audit (findings 50-54 in MULTIPLAYER_AUDIT_2026-10-15.md, a test
each that fails on the old code): work site grid writes during an in-flight
worker search at simDk > 4 (worker.js), background/foreground job failures
(per-lane error flags, drain before throw, dependent stages skipped:
sim_parallel.js), failed ticks (a guest repairs when its tick failed and the
host's did not: utils_resync.js resyncNoteTickFailed, host failure markers in
the hash stream), upkeep per elapsed second below 20 TPS (main.js), stale
input delay / pace from late host messages (version q). Regressions: 490/492
both modes (the 2 fixed and re-run), then all 84 multiplayer runs.

Benchmark (serial, nothing else running): `node --max-old-space-size=8192
tests/chaos-spikes.bench.cjs --units=1000000 --structures=250000 --ticks=240
--helpers=11 --dk=1 --kernels --system-metrics`. The population falls from
958k to ~290k by step 50 (combat; 289k-435k over the steady window, same in
every run below). Raw rows: tests/test-runs/chaos-spikes/audit-20261030-*.json.

| run | steady mean | p95 | p99 | max | >1.5x median | burst mean | normal mean | processActions (bursts) |
|---|---|---|---|---|---|---|---|---|
| dk1, start of session (audit-20261030-dk1) | 185 | 271 | 335 | 565 | 20 | 281 | 175 | 94 |
| dk1, after both fixes (audit-20261030-dk1-c) | 174 | 233 | 255 | 281 | 4 | 224 | 168 | 50 |
| dk20, after both fixes (audit-20261030-dk20-c) | 364 | 444 | 508 | 536 | 1 | 450 | 354 | 96 |

(ms per step; dk20 steps advance 20 base ticks, ~240k units.)

1. Step 200 spike (565 ms, 328 ms of it structRowsExpire): the structures
   destroyed in the opening battle keep their rows STRUCT_ROW_KEEP_TICKS (200)
   ticks, then 22k rows expired in one tick at ~15 us each. data_state.js:
   - The hidden properties (_sr, _sdet, _hgx, _hgy) are defined once at
     construction (structTableInit, one defineProperties) and written plainly
     at expiry: three shape changes a row before.
   - A table's due rows are popped with its arrays in locals (the table object
     is in dictionary mode, a property per column: ~0.6 us a pop through
     _sRowQueueUnlink), then cleared a column at a time: the rows radix
     sorted into runs, each column's runs by its native fill (one store loop
     for every column type was megamorphic, ~50 ns a store). Free order kept.
   - Isolated (scratch expire-bench, 20k farms/spawners/labs/barracks
     destroyed at once, every cleared row checked): 11.9 -> 0.7 us a row
     (0.9 shuffled), 250 ms -> 13 ms. Placement costs ~1.5 us more a
     structure (the defineProperties moved there: 360 -> 390 ms for 20k).
   - In the benchmark: step 200 565 -> 290 ms (profiled run), the expiry 328
     -> 55 ms (2.5 us a row there: heavier tables than the bench's).
2. Command bursts (every 10 steps, +100 ms; profiled, 22 bursts, ~92 ms of
   processActions each; tool: a self-time-under-a-function pass over the
   .cpuprofile):
   - getResearchQueueCapacityForPlayer, 540 ms of the 2 s: every
     queueResearch counted all ~29k labs. Now every player's count once,
     kept while the tick, the tile entity version/epoch (restores bump them)
     and the worker buildings' list are the same (data_dynamic.js).
   - setRallyMany by coords (the chaos commands' form): one building at a
     time through the table object's columns (_rallySetTile, ~7 ms a burst).
     From 32 buildings the tile keys go through k_rally_tiles as tkz rallies
     do (main.js _rallyKernelRun). As for tkz, buildings without a table row
     are not written (none in normal play).
   - processActions on bursts 94 -> 50 ms.
   Tests: 28/28 rally / research / order / multiplayer-determinism runs, both
   modes; 40/40 structure / snapshot runs after (1).

### Remaining (2026-10-30)
- Steady cost: simMoveRun ~78 ms a tick at ~290k units (kernel 8 ~34 ms, the
  four kernel 89 stages ~38 ms), processGlobalSpawnerQueue ~19 ms (serial
  JS, up to 66), unitEventsRun ~15 ms. Far from 50 ms a tick.
- Command bursts still +56 ms: _actionCleanIds and _actionRecordArrival
  (a hash lookup per unit id, ~15 ms a burst) and processAction's own work;
  candidates for a kernel (ids -> slots, stamp dedupe).
- Structure expiry 55 ms for a 22k wave in the real tick (2.5 us a row):
  the per-object writes and derived maps on full tables.
- destroyBuilding ~10 us a structure (20k: ~210 ms) and placement ~20 us:
  a destroy wave inside a tick pays it.
- The structure tables grew 11 times in this fixture (structRowStats.grown):
  against the static memory budget rule.
- dk20 steps: 364 ms mean, processActions 96 ms on bursts.

### 2026-10-31 — steady camera pauses in the supplied history scene

- Traced `tests/defence3-scene-2026-10-31T13-31-34-674Z.gz` in Edge at its restored camera/graphics settings (2D, Team + history, 796 units, 5,541 structure rows). Raw camera data, CPU profile and browser timeline are under `tests/test-runs/camera-steady-20261031/`.
- Baseline: repeated 50–100 ms browser tasks; a research queue refresh parsed/replaced roughly 3,000 DOM nodes, with ~21–28 ms JavaScript followed by layout, paint and raster work. The first trace had no slide-margin exhaustion, so the larger-margin theory did not explain these pauses.
- Reverted the enlarged camera overscan and the moving-camera pixel-snap exception. Research queue rendering now reconciles tiles by task identity and updates progress, costs, indexes, tooltips and active state in place, including after completion/reordering. Empty slots are retained.
- No post-change run: user requested immediate changes and will verify manually. Browser commit/raster stalls and residual camera behavior remain unverified; no simulation TPS or multiplayer improvement is claimed.

### 2026-10-31 (later) — camera stalls traced to bottom-bar rate text shadows

- Method: `tests/camera-steady-trace.cjs` (now 3 s held W/S; `EXTRA_CSS`, `HEADED=1` env) on the supplied scene, Edge. Browser timeline showed 50–110 ms main-thread tasks every ~250 ms with no JS inside: the main thread waited on a 75 ms raster task. Bisecting with injected CSS: hiding `#bottom-bar` or `.bb-rate` removed all stalls; hiding panels/HUD/research did not.
- Cause: `.bb-rate` had three blurred `text-shadow`s on ~800 spans, re-rastered whenever rates changed (BB_REFRESH_MS 250).
- Fix: hard-offset 1 px outline shadows; tile rate updates also keep the thumbnail `<img>` element (`_bbPatchThingBody`).
- Held-key frame gaps: p95 16.7 ms unchanged, max 108 -> 50 ms, long tasks (>50 ms) 11 -> 0. A few 25–50 ms gaps at the 250 ms cadence remain. Raw: tests/test-runs/camera-steady-20261031/{after3s,fix2}.json.
- Follow-up: any `text-shadow` on `.bb-rate` still cost 25-50 ms raster per 250 ms refresh (`text-shadow:none` removed the hiccups). Replaced with `paint-order: stroke fill; -webkit-text-stroke: 2px #000`. Two held-key runs: max frame gap 20.6 / 20.8 ms, p95 10.6 ms, 0 long tasks (was 108 / 16.7 before the first fix). Raw: tests/test-runs/camera-steady-20261031/fix3.json.

### 2026-10-31 (later) — scene 15-12-46 (392,624 units, 3D): GPU sync queries, lazy shaders

- Baseline (same 12 s held W/S trace): 718 frames, frame gap p50 16.6 / p95 33.3 ms. The CPU profile had `getParameter` at 3.9 s self time, all in `drawUnitClaims` (`gl.getParameter(VIEWPORT)`): the first synchronous query waits for the whole queued GPU frame, so CPU and GPU ran in lockstep.
- Fix: renderer3d keeps its own copy of viewport, framebuffer, clear colour, depth mask and blend function (wrapped setters); `drawUnitClaims` reads those. `getParameter` is gone from the profile. After: ~960–990 frames, gap p50 8.4–9.8 / p95 25 ms.
- First camera move compiled the FX and range-visibility programs (~140 ms + 65 ms): a restored scene never goes through `_maybePrewarm3DView`. `render()` now prewarms once (and the claim program too). The first-move 140 ms frame is gone.
- Remaining: frames of 25–33 ms with ~5 ms of JS; `(program)` (native wait) is ~half the profile, so these look GPU/present-bound at 392k units; `drawMinimap` 100+ ms on the first frame after restore. Raw: tests/test-runs/camera-steady-20261031/scene2*.json.

### 2026-10-31 (later) — research queue "move to top" no longer scrolls the panel

- The info panel's mouse anchor followed the clicked item to the top of the queue, so the view jumped. `lockInfoPanelScroll` (hud.js) records the scroll pane's position on the top/bottom reorder buttons and `restoreInfoPanelMouseAnchor` holds it for 1.5 s (dropped on manual scroll). Real-mouse test on the 13-31 scene (270-item queue, scrollTop 1500): three moves, scrollTop 1500/1500/1500; with the lock disabled 1500 -> 1433 -> 160.

### 2026-11-01 — perf fuzz on scene 15-12-46 (392k units, 7.4k barracks, 5.9k towers): big-selection spikes, info panel

- Tools: `node tests/perf-fuzz.cjs defence3-scene-2026-10-31T15-12-46-206Z.gz --minutes=18` (27 trials, 24 flagged; raw tests/test-runs/perf-fuzz-2026-11-01T10-52-32/) and the new `tests/select-all-spike-probe.cjs [scene] [rounds]` (real Edge, `?simtrace=1`: zoomed out, box over everything, right click (odd rounds attack move), Escape; frame gaps, long tasks, `updateInfoPanel` per call, per-tick phases; `PROF=1` page CPU profile; raw tests/test-runs/select-all-spike/).
- Worst page spikes (select everything, then orders/rally): one 390-460 ms frame of `updateInfoPanel`: the group renderers ~230 ms (energy display / stat entries / vision / upkeep / spawn bars over each group's 1024-member sample), `panel.innerHTML` ~106 ms, ~90 ms of string building/slicing. The panel of a select-all is 677k characters, 7,020 nodes, 71 sections; a third of a section's markup was inline coordinate JSON (`data-count-spec`, groups up to 512 inline), another third inline styles.
- Sim worker: `simPresentationMetadata` walked all units through the `units` proxy (two trapped reads a unit): ~600 ms per 10 s of the sim thread. Now reads the array (re-fetched after each yield).
- Interim panel changes: a refresh stops making sections after INFO_PANEL_BUILD_BUDGET_MS (2) for selections over 2048 (the rest show their header and are made by the next frames' refreshes, `_infoPanelPendingSections`); spawn-bar coordinates inline only up to 8 (else a token). Measured (probe, 4 rounds): the 390 ms frame is gone, but a select-all is now ~40 refreshes of 10-25 ms (frame p95 50 ms for ~3 s): each refresh has a ~12 ms floor (layout forced by the mouse anchor ~400 ms per 6 s, section `innerHTML`, string joins) besides the sections.
- Decided with the user: the panel becomes static (pooled section elements made once, values written into text nodes, rows/buttons shown or hidden; no markup made per refresh), fed by a packing worker that computes every group's sums over all members from the shared structure/unit columns and a (owner, key, level) stat table. Not done yet.
- Also seen: after an attack move of 220k units into the enemy the sim ran ~180 ms a tick (TPS 3 for ~1 min; the battle itself); in calm the scene's tick is ~60 ms (simMoveRun 36). Not traced yet.
- Tests: research-menu, input-stress pass.

### 2026-11-01 (later) — info panel: static sections + packer thread (in progress)

Direction from the user: the panel never makes markup per refresh (values written into text nodes, rows/buttons shown or hidden), the numbers come from a background thread (wasm where it helps), everything is made at the match's start, no fallbacks or first-use work in play.
- Structure presentation table in the wasm heap (sim_presentation.js `_simStructTableNew`; replaced tables retired after 5 s; messages carry off/bytes; the presentation worker copies only that block; `simTableViews(spec, buf, cap, off)`).
- Packer thread `src/audio_visual/info_pack_worker.js`: instantiates the kernels on the simulation's shared memory (`simInfoPackPayload`: helper payload + its own heap blocks + a header with the table's address), asked for at the match's start (sim_client 'started' -> `infoPackMatchStarted`). Kernel `wasm/src/info.rs k_info_bins` bins a selection's structures by (group, owner, level, elevel, state) with counts, energy/amount sums, queue sums, flag counts, rally range: select-all on the 392k scene (33k structures, 144 bins) 1.4-4.9 ms a pass, every 100 ms, off the page.
- Static panel `src/audio_visual/info_panel_static.js` (main panel only; popups still markup): a pool of 96 sections (20 rows, buttons, slider, bar) and 96 subgroup toggles made at `startGame`, controls bound once; group models from the bins, stats memoised by (stat, owner, type, unit type, levels, state) per stat-table version. Still markup, patched in place: a single selected thing's panel, a research group's queue block, the player status.
- Measured (tests/select-all-spike-probe.cjs, 4 rounds of select-all / move or attack move / Escape, raw tests/test-runs/select-all-spike/static*.json): the old 390-460 ms frame and the interim 40 x 10-25 ms refreshes -> refreshes of 10-12 ms with everything selected (first one 27-117 ms), 0.3-0.7 ms with nothing selected. Long tasks of 100-150 ms in the select window remain (GC 150-170 ms pauses after a big selection; box-select handler).
- Next: the packer computes every group's numbers (unit groups binned there from the frame columns too, a numeric (owner, key, level) stat table made at the match's start and re-made in idle slices on research), the page only formats and writes; single-thing panels and the research block as static rows; then the selection GC pauses.
- Tests: research-menu, input-stress pass.

### 2026-11-01 (later) — info panel: one static element per thing type, every number from the packer thread

Rebuilt to the user's design: the main panel is one markup string made at the match's start (main.js startGame -> info_panel_static.js infoPanelMatchStart): a section per thing type (every building type and barrack variant, both mines, every unit type) with all its rows, the subgroup icons, the summary; controls bound once. A refresh shows the types in the selection and writes the text the packer made (only what changed). The in-page simulation (simworker=0, tests) keeps the old markup panel; the mode is fixed at the match's start.
- Packer (src/audio_visual/info_pack_worker.js, fields in info_pack_fields.js): groups the selection by type from the table / frame codes; structures binned by the wasm kernel (k_info_bins); units binned from the frame's shared columns (typed open table, slots radix-sorted once per selection); every group's numbers from the stat tables read in place in the wasm heap (data_dynamic.js _flatThingStatEntry allocates them in the heap on the simulation worker; sim_presentation.js simInfoPackStatDir: owner/kind/key -> address and columns, re-sent if a table is remade); rows formatted there (formatBigNumber and friends carried over). Out: a Float64Array of numbers per group (pills, slider, summary) and each group's row strings.
- Hiding: a section not in the selection is `content-visibility: hidden` (its rendering kept), a shown one `content-visibility: auto` (laid out only while in the panel's view). With display:none a select-all was 183 ms of layout (104 ms text shaping) + 39 ms style; now 34 ms at most.
- Box selection in a 3D far view runs in the packer too (units from the frame columns, structures from the heap table, the same ground-point projection): get3DBoxSelection was ~66 ms a select-all (13 ms the unit pass, the rest structure getters/closures). main.js boxSelectionApply applies the result (shift union, unchanged check, index).
- Fixed on the way: the ★/s status rows scanned every unit for the owner's types (~3.5 ms a refresh at 390k): from getFrameUnitSummary now. The selection outline's shader compiled at the first big selection (~31 ms): prewarmPrograms (renderer3d.js ensureSelMaskResources).
- Measured (tests/select-all-spike-probe.cjs, 392k-unit scene, raw tests/test-runs/select-all-spike/cat*.json, cv1, box1; TRACE=1 writes a browser timeline): page apply with everything selected 1.9-2.3 ms (about half the research block's markup, still made per apply), nothing selected 0.4-0.6 ms; packer 15-30 ms a pass on its own thread (units ~22 ns a selected unit in isolation, 2-3x that in Edge beside the simulation's 11 helpers). Selects after the first: no long tasks, frame gaps <= 33 ms.
- Left (the user saw the first select's drop in the probe window): the first select still has a 60-80 ms frame: _simClientUpdateStableSlots (sim_client.js; every membership change compares all ~450k slot ids and rebuilds the 392k-entry `units` view list: O(units) page work a few times a second in a fight, likely the 150 ms GC pauses), the first order (issueOrders over 33k selected buildings: isRallyCapableEntity, activeStructureSelection; ~48 ms), getSelectionMaskOverlay. Still markup: the research block and the player status (to become static rows). Near view (<= 20k units) box selection and 2D box selection still on the page (the user: move them to the helper too, the top point tested beside the ground point instead of the drawn-mesh test). The user rejected throttling UI blocks (once a second): never.
- Tests: research-menu, input-stress, camera-interactions pass.

### 2026-11-01 (later) — first-select, order and deselect spikes gone (392k scene)

- Page `units` list (sim_client.js): one persistent array filled only when page code reads past its length (data_state.js `_unitsPv`, `unitsSetViewLazy`; `units.length` from the frame's count). It was rebuilt (392k views, new array) at every membership change, several times a second in a fight; the probe counted 0 fills during play. The stable-slot pass keeps a reused Int32Array of changed slots.
- Box selection, every mode (3D near and far, 2D) in the packer (info_pack_worker.js boxSelect): own units from the frame columns, own structures and mines from the heap table; 3D hit = ground point or top point inside, or the segment between them crossing the box (instead of the page's drawn-mesh test); main.js boxSelectionApply. The page's own path stays for the in-page simulation.
- Order ids (hud.js _slotUnitIds) made by the packer when the selection changes: all / combat / worker ids and their wire strings per ACTION_MAX_UNIT_IDS piece (id_codec.js, same encoding on every peer); worker.js _queueLocalAction takes them (`_uidzMade`, never sent).
- Section layout prewarmed at the match's start (_ipsPrewarmLayout: every section laid out once, then content-visibility hidden keeps it).
- Bottom bar tiles' rates written into their spans (bottom_bar.js _bbWriteThingBody) instead of a template + replaceChildren per changed tile (~42 ms frame after a deselect).
- Selection outline programs prewarmed (earlier entry).
- Measured (select-all probe, 3 rounds, raw tests/test-runs/select-all-spike/bb1.json): no long task in any window (first select included; worst first-select frame gap 78 ms); order windows 0 long tasks (were 55-71 ms); deselect 0 (was 53-65 ms); TPS ~20 in calm (was ~15 in earlier runs).
- Near camera (tests/camera-steady-trace.cjs, held W/S, near1.json): gap p50 9.9 / p95 19.6 ms, page JS p50 3.2 ms a frame; the rest is native (GPU/compositor). Page O(units) passes still per frame: minimap unit paint (~0.3 ms a frame), unit counts by owner/type (_frameSummarySlice ~0.2), stable-slot id scan (~0.12), minimap alerts (~0.11); a 100 ms first minimap frame and a 55 ms gpuSubmit frame at the start.
- Left: those per-frame passes to the packer (the minimap needs the page's visibility grid in shared memory); research block and player status still markup; the packer's box test and order ids have no worker-mode test yet (the repo's tests run the in-page simulation).
- Tests: scene-orders, input-stress, research-menu, camera-interactions, box-selection-index, frame-order-slots, order-fast, order-markers, selection-performance pass.

### 2026-11-01 (night) — static research block and player status, packer tests, the 1M/250k chaos scene in Edge

- New Edge scene of the chaos benchmark's world: `node --max-old-space-size=12000 tests/chaos-spikes.bench.cjs --units=1000000 --structures=250000 --helpers=11 --export-ticks=0 --export-scene=tests/scenes/chaos-1m-250k.gz` (1,000,004 units, 287k structures, 1024 map, research queues, every worker job, salvage and building sites; `--export-ticks=N` runs N steps first). Loads in Edge (`tests/select-all-spike-probe.cjs scenes/chaos-1m-250k.gz`, `tests/perf-fuzz.cjs scenes/chaos-1m-250k.gz`). The armies fight at once: ~1M -> ~240k units in ~80 steps. Free memory falls to ~0.4 GB while it runs (16 GB machine): page-ins of 1-5k/s, so absolute times are pessimistic.
- First Edge look (select-all probe, PROF=1, raw tests/test-runs/chaos-edge-20261101/selall1.json, prof2.json): page frames p50 150-550 ms (2-4 FPS) even calm, long tasks to 600 ms. Page profile (26.5 s): `drawSiteMarks` 8.3 s (a projection, a scene-depth read and a 2D drawImage per salvage/building-site mark per frame, ~25k sites), `rebuildPrecomputedStatsMapPlayer` 3.5 s (the page remade a player's whole stat table at every finished research level), bottom bar research strip 1.2 s (every tile patched at every progress change), `_simClientUpdateStableSlots` 0.8 s, `getFrameBuildingSummary` 0.5 s.
- Site marks on the GPU: `siteMarkInstances` (renderer.js) writes x, z, kind per mark into a Float32Array once a tick from the frame's structure table flags (pending salvage presses folded in, rebuilt every 100 ms while one is pending); `drawSiteMarksGpu` (renderer3d.js) draws them in one instanced call (sprite atlas of the two marks, lift 0.72, half a tile held to 6-26 px, depth tested with the overlay's 0.0012 bias so the own model never hides it), uploaded only when the list changed; prewarmed with the other programs. Checked by screenshots with the pass on and off (tests/test-runs/chaos-edge-20261101/m4-b*.png).
- Page stat tables: `pageApplyState` (sim_frame_world.js) diffs each player's research levels and remakes only the changed stats' rows (`rebuildPrecomputedStatsMapPlayerThingStat`, as the simulation does); boosts, a new player or >32 changed stats remake the whole table. The two JSON signatures a player per state apply are gone.
- Bottom bar research strip: a tile is drawn again only when its stat, level, progress, cost, active or open state changed (`_bbDrawn`); a shift in the queue updates its `data-index` only, its hover text (which names the place) is written when the pointer comes onto it (`_bbResearchHover`).
- Minimap static layer beside the simulation worker: `_minimapStaticFromTable` (renderer.js) makes the whole layer from the structure table (owner colours, cell items at 30%, mines) with typed pixel writes and one putImageData, for any change; the canvas path (a fillRect a structure, a pass over every grid cell through its getters, ~130 ms at 287k structures, redone whenever >4096 tiles changed between minimap draws) stays for the in-page simulation.
- After these (prof3.json): page frames p50 8.3 ms (calm p95 91 ms, was 433), drawSiteMarks and the stat rebuilds gone from the profile. Left on the page (15.4 s profile): combat effects `_pushCombatRecordFx` 1.2 s (all 16,384 effect records walked and their geometry built on the CPU every frame: wants a GPU effect pass), minimap static layer 1.4 s (before the table path), research strip 0.5 s (before the index change), `_frameSummarySlice` 0.47 s and `getFrameBuildingSummary` (per-owner counts: to the packer), `_simClientUpdateStableSlots` 0.42 s. `tests/profile-long-tasks.cjs <page.cpuprofile> [min ms]` lists the busy runs of a page profile with their top functions.
- Simulation in Edge at this size: steps p50 ~510-560 ms, p95 ~840-940 ms (adaptive dk); slow steps: spatialIndexRebuild 370-400 ms (tick 4), processGlobalSpawnerQueue 150-250 ms, workerSearchTierStep/_wsCommit 160-210 ms, simMoveRun 120-270 ms. The 392k scene's attack-move battle (tests/test-runs/battle-20261101/attack1.json, 60 s): ticks p50 72 / p95 124 / p99 177 ms, TPS ~9, simMoveRun 70-180 ms a tick; frames stay at 8.3 ms p50.
- Info panel, static (info_research_static.js, made at the match's start from info_panel_static.js): the research block (queue toggle; the queue in a list of its own height with a pool of 9 row elements placed where its scroll shows them, filled for those rows only; the research things' buttons; a stat row per stat group of every thing, shown for the things picked; sliders written in place) and the player status (every rate row, roster row and separator for every unit and building type made once, shown when the player has some; the ★ rates from one pass over the log a window length instead of one per row; the online players' and network rows made again only when the players or the toggles change). Their controls are bound once at the start (`bindInfoPanelSectionControls` is local to updateInfoPanel: the static block binds its own).
- Fixed on the way: `openResearchStatMatrixPopup` had been deleted in 07e4451 while three callers remained (the research rows' M buttons threw); restored. Cloud portal towers (`tower:cloud_*`) were missing from the static roster keys (types outside the towers' list get both keys).
- New test `tests/static-panel-edge.test.cjs [scene]` (real Edge, the simulation worker, the 13-31 scene): the packer's box selection in 2D (exact) and 3D (against a page-side reference of the same rule and projection; 1 of ~800 moving units may differ), its order ids and wire strings (decoded = the ids), a right-click order sends the packer's wire strings (no ids encoded on the click), the research block (rows = the queue's first and, scrolled, last tasks; a picked thing's stat rows), the player status (a roster row per unit and building type the player has), and refreshes making no elements. 8/8 pass.
- Tests: static-panel-edge, minimap-columns, research-menu, research-queue, order-markers, renderer3d-panels, flat-gpu-renderer, building-research-keys, input-stress, camera-interactions pass.

### 2026-11-02 — units spawn as table writes (stage U1 of TABLES_CONVERSION_PLAN.md)

- Edge, 1M/250k chaos scene (`.claude/scene_tps_probe.cjs scenes/chaos-1m-250k.gz` with WPROF/WEVAL): 35,559 spawns in 32 ticks (~1.1k a tick, the population cap 1M), ~68 us each: `processGlobalSpawnerQueue` ~125 ms a step, the `Unit` constructor 4.1 of 41 s of the simulation thread. A unit has 4 own fields (`_us`, `_si`, `_det`, `_rm`), the other ~190 are accessors over columns; the constructor wrote ~100 of them through their setters, 81 to the values the fresh slot already held (19 columns change: id, owner, jr_unitType, upT, x, y, prevX, prevY, x0, y0, energy, r, collisionR, unitLevel, baseLevel, effectiveLevel, stackCount, effectiveStacks, upB).
- `simSpawnUnit` (unit.js; spawns, starting units, splits, scene loads): the slot, then those columns written directly; `_simUnitSlotStart` resets a slot's JavaScript and object fields only if the slot ever held a unit (`sl.ever`; typed JavaScript-field columns are filled with their defaults when they grow). Bug found on the way (two-peer chaos test): first keyed on the used bit, but a released slot zeroed by k_slot_zero is unused again with its last unit's JavaScript fields (holdPosition, pathIsFallbackAstar, ...): peers with another slot history diverged after a repair.
- Stats: `_spawnStats` copies what the level scaling writes for an (owner, type, level, worker type) as a generated straight-line write (13-16 columns: statRow, esOk/esType/esRad/esVer, mvLane, mvReachD/A, mvShoot, mvRangeK, lzFlags, maxE, jMaxE, the two stat references), made by the full path for the first; void when the (owner, type) tables' version or the effective rows (`_effRowEpoch`, things_utils.js) change. Not keyed on `_precomputedStatsVersion`: research of some type finishes almost every tick here (it was a miss nearly every spawn).
- Rally template paths: a WeakMap by spawner (exit, rally tile, movement profile, topology version, TTL) instead of a shared map by a ten-part joined string made each spawn.
- `tests/unit-spawn-columns.test.cjs`: units of every type at two levels, constructor vs simSpawnUnit (the first of a key and a copied one): every column equal except position/id/spatial ones and cbTick/cbS (stale acquisition-commit values in never-used slots, trusted only when equal to the commit tick).
- Measured (Edge profiles p3-p6, tests/test-runs/sim-prof-20261101/): processGlobalSpawnerQueue ~125 -> ~53 ms a step; per spawn ~68 -> ~24 us (simSpawnUnit 1.34 s of ~31 s). Whole-step means vary 450-600 ms between identical runs here (memory paging at 1M units): compare phases in the profiles, not the totals.
- Effects A/B (tests/fx-ab-probe.cjs, same scene and camera, effects on/off/on/off, 2D and 3D): buildFrameEffects p50 0.3-0.5 ms, p95 ~1 ms a frame; FPS differences between windows are the match changing, not the effects.
- Next (TABLES_CONVERSION_PLAN.md): fold the per-unit copies (U2), batch spawn in wasm without handles (U3), structure rows as the presentation source (S1: `_simWriteStructure` copies every structure's ~45 fields through accessors, ~28 ms a step), then movement (~170 ms a step, the largest phase).
- (later, 2026-11-02) Two-peer determinism (`tests/multiplayer-chaos-determinism.test.cjs`, all six maps) failed after the spawn rewrite: the host's units differed from all restored guests'. Bisected with copies of the tree per variant (constructor spawns pass; the constructor's writes replayed on the handle pass; then by write group): the constructor's `targetUnit = null` / `targetBuilding = null` / `targetPos = null` cleared target values (tuS, tuId, tbT, acqB, mvTgX/Y) that kernels leave in slots holding no unit. simSpawnUnit writes those defaults now. Also: the slot reset keys on `sl.ever` (a slot that ever held a unit), not on the used bit (a released slot zeroed by k_slot_zero is unused again with its last unit's JavaScript fields); stat templates are cleared at every snapshot decode; `unitType` is an accessor over the type index `upT` (canonical: BASE_UNIT_STATS' order, then first sight), no string column. All six maps pass; `tests/unit-spawn-columns.test.cjs` passes.
- Measured after these (Edge profile p7): processGlobalSpawnerQueue ~40 ms a step (2.45 s of 31 s; was ~125); simSpawnUnit 1.13 s, of it the slot taking 0.45 s (most spawns take recycled slots in this battle: the JavaScript-field reset; next: reset at release in the slot-zero kernel), stats copy 0.19, spatial 0.10, worker set-up 0.10, occupancy 0.10.

### 2026-11-02 — where the 1M-scene step goes now (Edge, named wasm32 profile n1, dbgc counters, par_share probe)

- Tools: `node wasm/build.cjs --wasm32 --features=prof --keep-names --target-dir=target-chaos-profile --out=tests/test-runs/named/named-wasm32.js` and `WASM32_OVERRIDE=<that> .claude/scene_tps_probe.cjs` (new: the 32-bit override; WASM64_OVERRIDE existed); `--features=dbgc` + WEVAL reading `_simWasmArgs+1536*4` gives the simulation thread's movement/occupancy counters (it runs ~8% of the chunks: a fair sample); `.claude/probes/par_share.js` (WEVAL_START): per foreground kernel, chunks, the simulation thread's share, wall per run; `.claude/probes/mv_states.js`: live units by mvOn/command state.
- Simulation thread ~450 ms a step (dk=1, ~285k units: 153k moving (mvOn 1), 125k parked, 98k workers). Helpers: 102 s busy of 11 x 31 s (~30%): the critical path is the simulation thread.
- Movement ~145 ms wall a step: the parallel kernels are evenly shared (the simulation thread takes ~8% of chunks, busy ~95% of each run: no claiming problem); kernel 8 (move) ~45 ms, kernel 89 stages 0-3 ~64 ms; ~0.9 s of CPU a step across threads (~6 us a moving unit). Of it checked_traffic_q 19 of ~40 s (MoveGrid::preview 9.3, traffic_swap 2.5, seg_open 1.9, commit 0.9); counters: ~1.1M occupancy motion tests a step (~7 a moving unit: blocked diagonals retried per axis (27% of diagonals), up to four shoulder directions each with a wall check and a preview), mostly one-cell disk tests.
- Serial on the simulation thread (ms a step): spawning ~55-65, k_worker_ai ~45 (+ waiOutEvents ~13; one event list with reservations/payments/emits as it goes), worker search tier ~50, presentation pump ~45 (_simWriteStructure ~25: the rolling sweep rewrites every structure every ~17 steps, mostly derived-stat getters (per-type spawn cooldown, vision, max energy) recomputed each time), _simPostResult ~29, towers/structure statuses ~10.
- Candidates by wall time won: the serial phases onto the idle helpers (worker AI as a parallel decide + ordered commit, the presentation sweep as a background job over the class tables, spawning as a batch), then movement: a 3x3 neighbourhood free-mask per unit instead of 6-7 separate disk tests (~12% of movement), and fewer retries for units blocked in the same place (a behaviour change, deterministic).

### 2026-11-02 — the result post: state as deltas, events packed

- Edge 1M/250k chaos scene, sim worker profiles n3-n11 (tests/test-runs/sim-prof-20261101/). Heap sampling had `_simPlain` (sim_frame_world.js) as the worker's largest garbage source (~54 of 149 MB in 20 s): `simFrameEncodeState` deep-copied every player each tick, including ~1,600 research tasks a player (~300 KB) and ~500-key research level/multiplier maps; `_simPostResult` was 936 ms of 31 s (encode 407, postMessage clone 376).
- Players (`_simPlayerEncode`): the research queue as {__qd: [drop k from the front, keep j], tail, np: numeric patches of kept tasks whose levels/work moved}, checked by task identity and five unrolled numbers (allocation-free); `researchLevels`/`researchMultipliers` as changed/removed keys against a copy of what was sent, checked when the current task or queue changed (a finished research changes both) and every 10th frame; unchanged keys listed in `__same` and kept by `pageApplyState`.
- Areas: a typed copy of each area's sent state, only changed areas (`areasD`); the simulation marks the areas it changes (`markAreaDirtyId`, data_state.js: adjacency lane commit, area upgrade; restores/resets mark all) so the encoder checks those instead of all ~16k (dirtyAreas was set nearly every tick). Upkeep is stringified only when its array is replaced (once a second).
- Events (`_simEv`, sim_worker.js): one Float64Array a tick ([op, argc, (tag, value)...], strings in a per-post table, refs as unit id / gx*65536+gy, objects fall back to arrays), transferred; decoded by `_simClientReplayEvents` into one scratch array. Was ~5k small arrays a tick (~260 KB as JSON) allocated and cloned.
- Measured: `_simPostResult` 936 -> 201 ms of 31 s (encode 407 -> 51, postMessage 376 -> 12, events take 23); posted state ~41 KB -> ~4 KB a tick; worker GC 531 -> ~220-310 ms of 31 s (noisy).
- Tests: `tests/player-state-delta.test.cjs` (random queue/level/multiplier/area mutations encoded, structured-cloned and applied: page = simulation; flat maps may lag <10 frames), `tests/sim-event-pack.test.cjs` (every event kind and the object fallback round-trip).
- Verified: tests/multiplayer-chaos-determinism.test.cjs (all six maps), research-queue, research-menu, combat-effects, static-panel-edge (9/9) pass.
- Where the tick goes now (Edge profile n11, 31 s, ~230k units): _gameTickBody 20.2 s: simMoveRun 8.0 (parallel; simParallelRun waits 1.5 of it), unitEventsRun 3.4 (k_worker_ai 1.7-2.0, waiOutEvents 1.0), processGlobalSpawnerQueue 2.8 (simSpawnUnit 1.3; the rest stat lookups, accessors, rally paths), workerSearchTierStep 1.6, towersTick 0.7, visibility 0.5. The sim thread idles ~6.6 s (paced to real time); the presentation pump (2.3 s) runs in those gaps.
- Worker AI (named profile nm2, brains not inlined under the prof feature): 13.5k events a step, ~2.6 us each, spread over ~15 functions with no hot spot (random SoA access at scattered slots: cache misses). Categories (temporary counters): 57% are moving workers that did not move and early-out (~1.5 us, ~35% of the kernel), ~40% full decisions (~3.3 us). Parallelizing only the early-outs saves ~2% of the tick; the full win needs a parallel decide + ordered commit (shared reservations, payments, emits).
- Spikes (simtrace, 80 steps): p50 327, p95 601 ms. Outliers are scene-load transients: the first step (3.3 s: unit collect 0.9, first worker events 0.9, first tower acquisition 0.5) and full spatial-index rebuilds in the first ~20 steps (40-280 ms, before the pre-build chain runs). Steady steps vary with the battle, no phase spike.
- Next: batch spawn in wasm (U3), worker AI decide/commit on the helpers, movement occupancy tests.

### 2026-11-02 — spawns as a batch, its columns by a wasm kernel (stage U3 of TABLES_CONVERSION_PLAN.md)

- Before (Edge profile n11, 32.6 s): processGlobalSpawnerQueue 2.82 s (86 ms a second of profile), ~44-50 us a spawn: simSpawnUnit 1.34 (slot start 0.39, stats copy 0.25, spatial 0.15, worker set-up 0.12, occupancy 0.09, own column writes ~0.18), the scheduler's own ~0.49 (every owner's head checked again for every spawn, through structure accessors and a Map iterator), the spawner side (queue shift, rally, listing) ~0.8.
- Scheduler (barrack.js processGlobalSpawnerQueue): an owner's head is found once a tick (_spawnHeadOrder) and again only for the owner that spawned (a spawn changes only its own spawner and its owner's population); same order as before.
- Batch: _spawnBegin (checks, exit tile, unit.js simSpawnBatchAdd: handle, slot, id, owner/type and worker set-up, the template's JavaScript-only fields) for every spawner picked, in order; then simSpawnBatchWrite: one k_spawn_write (wasm/src/nfs.rs, SIM_KERNEL_SPAWN_WRITE 130) writes every new unit's heap columns from programs of (column, source, value) triples: the core (id, owner, type, position x6, r, collisionR, levels, cleared targets), the unit's stat template (made by _spawnStats from the first unit of its key, which the full path writes at once, its row skipped), then energy = maxEnergy; on the helpers from 512 rows (column table: the slot-zero kernel's, plus a kind per column). Then _spawnEnd for each in order: simSpawnBatchFinish (upkeep bin, occupancy, spatial index), then the spawner's side as before. spawnQueuedUnitFromSpawner is a batch of one.
- Behaviour change (deterministic): a step's spawns are picked before any is placed, so a spawn that finds no room at its exit still counts against its owner's population cap for the rest of that step (given back at once; the spawner retries next step). Before, a later spawner of that owner could take its place in the same step. tests/spawner-queue-performance.test.cjs's reference models this.
- Bug found on the way: simParallelRun hands the helpers _simParams, not the caller's own params array (the direct call copies its P): the first version filled its own array, the helpers ran with another kernel's params and the simulation stopped (sim worker hung; the probe then waited forever on its CDP calls). .claude/scene_tps_probe.cjs now gives up on a worker's answer after 20 s and says so.
- Measured (Edge, profile sb1, 36.9 s, 55,276 spawns): processGlobalSpawnerQueue 2.46 s = 67 ms a second of profile (was 86: -22%), ~44 us a spawn. Of it: _spawnEnd 1.06 (finish 0.28: spatial 0.15, occupancy 0.08; queue shift 0.11, worker rally 0.09, rally paths ~0.2, unitAdded 0.05), _spawnBegin 0.91 (simSpawnBatchAdd 0.74: slot start 0.32 of which the JavaScript-field reset of recycled slots 0.18, worker set-up 0.17, template lookups 0.1), head checks 0.37, the kernel 0.03 (helpers). Spawning is ~11% of the tick (was ~14%).
- A 3.6 s step (unitEventsRun 3.2 s) in the trace of the profiled run is the profiler's attach to 17 workers (code recompiled): not in the profile (longest unitEventsRun call 134 ms) and not in the run without the profiler (its slowest step the first after the load).
- Tests: tests/unit-spawn-columns.test.cjs now also spawns through the batch (the first of a template key, copies of a template made in the same batch and of an older one: 120 units, 80 by the kernel), every column = the constructor's with energy = maxEnergy; it reuses its tiles for each type (all 40 type/level pairs now, was 12) and ignores wkIx (a pool index). multiplayer-chaos-determinism (six maps), spawner-queue-performance, sim-event-pack pass. The chaos harnesses count spawns at _spawnEnd.
- Left in spawning (us a spawn): the JavaScript-field reset of a recycled slot (~3: ref and sparse columns, outside the heap), the head checks (~7 per spawned unit: stale ready entries through structure accessors), worker set-up (~3), spatial index (~3), the spawner side (~19: rally paths, queue front stats, listing). Next for it: JavaScript fields as heap columns reset by k_slot_zero (U2), the ready list as rows (S2).

### 2026-11-02 — worker AI on the helpers, production as table passes, waits that work (WORKER_PARALLEL_PLAN.md, TABLES_CONVERSION_PLAN.md S2)

- Worker AI (wasm/src/wai.rs): the events and the search tier's takes are decided on the helpers (k_wai_decide, 128 events a job, worker.js _waiParallel: the kernel's ~155 arrays and params in one heap block every helper reads) against the shared state as at the pass's start; an event's writes to shared tables (structures' energy and build state, queues, a healed unit's energy, research rows) go to its own overlay (read back by it, applied after), its sums (payments, energy log, counters, work versions, research points) and reservation changes to its chunk's lists, as do its out events, freed path windows and mine takes. k_wai_apply (one job, the chunks in event order) writes them: out events and freed windows in order, the writes in order (the last wins), the sums in order (the same whatever the chunking), the mines, one payment row per owner and lane, then the reservations: per slot the holder kept or the lowest id of the takers (today's rule; the evictions moved here); takers that lost go idle, a take's request back for another round (up to 16 a step: ten builders on ten contended sites are matched in one step, tests/worker-take-rounds.test.cjs). WAI_PARALLEL = false keeps the serial pass (A/B).
- Mines: a take is the mine's table value less the take and its region sum term in wasm (wai.rs mine_apply; _ST.mineSum / mineAt in the heap; the mine's gold/astar accessor reads the table); only an emptied mine goes to JavaScript (_waiMineGone). Adjacency after stacking recalculated once per pass, not per event.
- The sorted unit events split on the helpers (k.rs k_unit_events_split): the worker kernel's events listed (their prevX/prevY written), only the rest walked in JavaScript.
- Spawner production (wasm/src/spr.rs; barrack.js spawnerProductionPass): every step each barrack's and spawner's row is brought up to date on the helpers (its timer from its front's payment, not ready while unpaid), the newly paid get ready tickets (Int32 column, ++counter, rebased far before overflow), the ready ones are taken by ticket within their owners' population room (radix sort; k_spawn_select), the queues of those that spawned move on together (k_spawn_shift); cooldowns and next costs by spawner type, owner and base level in a table the JavaScript fills for the keys the pass reports. The per-payment and staggered JavaScript updates and the per-owner ready lists are off while it runs. Bug found on the way (Edge: 543k spawns in a window, 830k units): the list of spawners to shift lost entries past 64 a step; tests/spawner-production-pass.test.cjs (150 barracks, one step).
- Waits: a waiting simulation thread (a background lane's wait, a foreground job's last chunks) takes chunks of other pending lanes (tick, hash, index, tiers, traffic; not the bulk lanes) before sleeping (sim_parallel.js _simBgHelp; SIM_BG_HELP = false: A/B). Edge A/B, same build: mean step 449 vs 535 ms, late 224 vs 323 ms, trace p50/p95 376/714 vs 436/768 ms.
- Search tier: k_ws_order no longer sorts by id (the takes settle by id), chained after the scan.
- Measured (Edge 1M/250k chaos scene, profiles sb1 -> wp2, ~36 s each): unitEventsRun 4,278 -> 1,437 ms; processGlobalSpawnerQueue 2,456 -> 1,883 ms with 13% more spawns (~44 -> ~30 us a spawn); search tier 2,233 -> 2,047 ms; worker GC 694 -> 228 ms. The simulation thread's total tick time stayed ~the same (22.7 -> 23.2 s): it now also runs other lanes' chunks while it waits (counted inside simMoveRun: 1.5 s), and runs a larger share of the movement's chunks.
- Tests: two-peer chaos determinism (six maps; and with the host on 4 real helpers, CHAOS_HOST_HELPERS=4), every worker test (area-worker-search, builder-research-resume, collector-farms, mine-region-sums, research-queue, research-rebase-partial, worker-approach-occupancy, worker-brain-spawners, worker-completion-publication, worker-created-start, worker-fallback-upgrade, worker-search-deltatick, worker-walk, multiplayer-worker-lost, order-worker-budget), unit-spawn-columns, spawner-queue-performance, sim-event-pack, player-state-delta, worker-take-rounds, spawner-production-pass pass.
- Left (Edge profile wp2, ms a second of profile): movement ~290 (incl. helped chunks), search tier ~53 (the scan's wait ~17, the collectors' group rebuild ~16 serial, the grid sweep ~13 serial), spawning ~46 (unit handles, slot set-up, worker set-up, rally paths), worker events ~36, towers ~29, structRowsExpire ~23 (JavaScript: destroyed structures' rows), visibility ~18; the presentation pump ~79 in the idle gaps.

### 2026-11-02 — the worker search tier: near fields in many jobs, the grid sweep on the helpers, its lane first

- Edge profile wp4 (helpers' profiles summed): helpers idle 58% (230 of 393 helper-seconds), so the simulation thread is the limit; of the search tier's background work the scan 3.4 s and the collectors' near fields 2.1 s. A near field was one job a (group, owner) pair (a full-map 2D raster transform): 4 jobs in this scene, the chain's scan waited for the slowest and the order phase for the chain (wait 658 ms + 369 ms of scan chunks on the simulation thread).
- k.rs k_ws_nearfield modes 1 and 2: the same field in two chained stages of many jobs, rows (filled, seeded, left/right sweeps) then 64-column blocks (down/up sweeps, contiguous rows): the L1 transform is separable and the values (steps << 16 | rank) order as plain integers. tests/ws-nearfield-split.test.cjs: the two forms equal tile by tile.
- The grid sweep (k_wsw_set) in phases on the helpers through a generic block (k.rs k_block, sim_parallel.js simRustParallel: a direct-call kernel's arrays and params in one heap block every helper reads, no registered names): the tiles' flags computed in parallel, then written in the list's order with the counts (one job); its reservation-bits mode at once in parallel. From 512 tiles.
- SIM_PAR_BG_ORDER: T1 (the search tier's lane, waited for one tick after its post) right after the index lane; SIM_PAR_BG_RUSH_AT 6 (the rush group keeps the tick's fields).
- Measured (Edge, profiles wp4 -> wp5, ~36 s): the order phase's wait 1,064 -> 38 ms; search tier 2,607 -> 1,561 ms (35 ms a second of profile, was 68). Run-to-run variation of the whole step (mean 450-560 ms between runs of one build) hides this in totals; the simulation thread's idle time (6.6 s) and tick time a second are the same between the runs.
- Left in the search tier: the collectors' group rebuild at each post (~30 ms of CPU a post over ~250k candidate tiles, made again whenever any structure is placed or removed: an incremental update from the tile journal is the fix), the takes' apply (one job), the sweep waiting on its helpers.

### 2026-11-02 — helpers waiting help, look-ahead exit hint, no bindings per step

- Waits that work: a thread waiting for a background chain or for the tail of a foreground run takes jobs of the background lanes meanwhile (sim_parallel.js _simBgHelp). Edge A/B: mean step 449 vs 535 ms.
- Movement's look-ahead (mv.rs flow_look_calc) steps along the atlas with the run's own exit hint (atlas.rs atlas_step_h: the exit chosen for a source/destination pair kept while the steps stay in that pair) instead of choosing among the cluster's exits at every step. The shared looks' wall key is the wall changes within their reach (11x11 blocks, tch.rs keeps it with the 3x3 sums: mv.rs W_WBLK81), not every wall of the map. The per-job exit cache (16 sets) gave nothing measurable.
- Spawn stat templates as lists written by a loop (unit.js _spawnTplWrite), not generated functions compiled again at every template miss.
- Binding churn: a binding that changes makes every helper sit out the jobs after it until it takes the bind message. Counted in Edge (a wrapper over simParallelBind, 450 ticks): the region passes bound each owner's arrays by name each pass, the navigation substitutes bound new arrays each flush, the worker brains bound whichever caller's list. Now: the region passes through the block (k_block selectors 2/3, reg ident/owner), the substitutes' and the brains' lists made once at the match's start from the budget's population (flownav.js navSubReserve, worker.js workerBrainReserve: one entry a unit, no growth in play) and bound once. After: 9 changed bindings in 450 ticks (diff.a, and the navigation/atlas tables at graph rebuilds).
- Measured (Edge, 1M/250k chaos scene, wp7 -> wp8, ~37 s, per-tick trace): step p50 428 -> 422 ms, p95 840 -> 673 ms; mean step over the last 12 reports 534 -> 501 ms; movement 199 -> 159 ms a second of profile; search tier 34 -> 26; spawner queue 38 -> 29. The max (~4 s) is the first tick after the scene's restore (setup).
- Left: graph rebuilds still allocate (navigation/atlas tables) and other in-play growth remains (unit columns, path pools, phase lists, JS maps such as the substitutes' cache): the static-allocation rule (allocate at match start only) is not met by those yet. Next by cost: movement's wall reads (seg_open misses: bit-packed walls), spawn JS (slot start, spawner index rebuild ~3 ms a step), structRowsExpire, the collectors' group rebuild.

### 2026-11-02 — no heap growth during play (in progress)

- Why: the wasm32 heap has 4 GiB; anything allocated mid-match can find no room. Rule: every work array is made at the match's start (a new match or a whole restore) at its bound from the settings.
- Census tool: sim_wasm.js simHeapPlayMark(sites) / simHeapPlayStats(): allocations from the heap after the mark (count, bytes, by call site as function names), memory grown. Edge: WEVAL_START='simHeapPlayMark(true);1' WEVAL='JSON.stringify(simHeapPlayStats(60))' on the scene probe. Chaos test: CHAOS_SIM_EVAL wrapping simHeapTick to throw the stats at tick 600 (a restore later replaces the hook).
- First census (1M/250k chaos scene, 674 ticks): 236 allocations, 276 MB, memory +211 MB. Navigation rebuilds ~185 MB, tower reach tables 80 MB, presentation structure table 57 MB, the rest small. The unit columns were reserved for 1.2M slots of a 2.1M budget (the 512 MB speculative cap): they would have grown mid-match with the population.
- Done: main.js simMatchReserve (at startGame after the unit slots, and at a whole restore) calls each module's reserve with {units (budget), slots, structs (structReserveRowsTotal), tiles, players}: the unit slots for the whole population (sim_unit_state.js, cap removed: 2.3M slots, heap 3.37 GB on this scene); navigation substitutes and worker brain lists (one entry a unit); the spawn batch (SPB_CAP 16384 spawns, its program buffer SPB_PROG triples restarted each batch, a template without room written whole; the production pass in batches of SPB_CAP); tile changes (each tile and kind once: 2 entries a tile, new walls one a tile); wall push-out (65536 pairs, a list split in halves when full); spawner production arrays, worker candidates and spawner index (structure rows); healer scan (slots); adjacency apply (structure rows); effect rows (lookup size); upkeep bins; the presentation structure table (structure rows, made at the reserve).
- After (same scene): 165 allocations in 642 ticks, all navigation (157, 132 MB) and tower reach (7, 80 MB) but one 1 KB table (fixed since). Tests: the full list passes (determinism with 0 and 4 helpers, 27 tests).
- Left: navigation builds (two sets a profile; tile and node arrays have small exact bounds, the exit nodes' fields do not: worst case k = clusters x 2C nodes, 128 MB a build at 1000x1000, 11 profiles), tower reach tables (area count x depth, depth grows with tower range), and the small chaos maps' long tail: path regions per owner, hits (_hitArrays/_hitStArrays, count-scaled), structure destroy batches, worker near fields, order arrays, visibility cover (map-sized, first use), work-site grid.

### 2026-11-02 — area range queries by blocks of 16 (SIMD_AREA_RANGE_QUERIES_PLAN.md), the reach table and the JS area caches gone

- Why: the towers' reach table held a row for every area of the map (126k on the 1M scene), at least 3 rings, deeper rows where towers reached, two sets (in use and next): ~100 MB here, ~400 MB at 2000x2000 (past its 16M-entry limit at today's ranges), made again in play when a reach grew. Units' in-range checks walked the area graph breadth first with stamps in the shared kernel scratch (another kernel could overwrite them). The JS side kept growing per-source caches (area distance maps, per-distance area and cell lists, pair unions, range boxes).
- wasm/src/arq.rs: areas packed in blocks of 16 (growth from each unassigned area, the candidate with the most edges into the block first), each block's hop distances confined to it (16x16 bytes), the cross-block edges as CSR. A query relaxes a whole block per reached area (saturated add and min of 16 bytes), cross edges at d + 1, level by level; areas come out nearest first. Pair checks: same area, same block within k (an upper bound), tile gap beyond k hops (a lower bound), then the search, stopped at the first target in reach. Each thread has its own context (argument word 1002 = sim_parallel.js _simThreadSlot; helper i is slot i + 1), left clean after every query: no stamps, nothing another kernel can disturb.
- Built once per layout (unit.js areaRangeIndexEnsure, from simMatchReserve and at a whole restore): 126k areas -> 9,476 blocks (83% full), ~7 MB with 12 thread contexts. Checked against a plain breadth-first walk on a 31.7k-area map: 400 enumerations (radii 0-63, one or two sources) and 2,000 pair checks identical.
- Towers: k_tower_prepare writes the query (tac.off: area, reach + 1) and its box (the movement's exact per-area boxes below 9 steps, else the area's bounds grown by reach x the largest area); k_tower_coarse answers "anything hostile in the box" in O(1) from the hostile summed-area tables (mv.hostile, rebuilt just before towers); k_tower_scan / k_tower_struct enumerate the reach with the index; k_tower_fire checks a preferred target by Arq::within. The reach table, its kernels (k_stationary_need/areas) and its JS (tower.js _stationaryReach*) are gone.
- Units: k_combat_brain's in-range check by Arq::within (the breadth-first area_within and its scratch stamps gone). Units' acquisition itself scans 3x3 chunks, so "nothing near" was already cheap there.
- JS: data_state.js _areaQuery / _areaWithin (the kernel k_arq_query on the simulation thread; on the page, for overlays, a breadth-first walk over typed arrays made once per layout). Removed: areaDistanceMatrix, areaIdsByDistance, areaIdsWithinDistance, _areaBfsDone, gridCellsByAreaDistance, gridCellsWithinAreaDistance, the pair unions, the range box cache, the dead forEachUnitInAreaRange.
- Measured (Edge, 1M/250k chaos scene): live heap 3.10 -> 2.94 GB; in-play allocations now navigation only (191 allocations, 125 MB in 704 ticks; the reach table's 80 MB gone). towersTick 31.9 -> 25.6 ms per second of profile, _towerAcqKernels 18.8 -> 15.1. Named profile: Arq::within 238 ms over all threads in ~30 s; k_combat_brain 0.9 s; movement (move_job, seg_open, atlas exit, traffic) still dominates. Per-tick trace (80 ticks, no profiler): p50 323-344 ms, p95 552-596 ms (was 422 / 673); the only slow tick is the first after the scene's restore. One profiled run had a 3.9 s _simPostResult on tick 26, not seen in two reruns without the profiler.
- Tests: the full list (37) passes, determinism with 0 and 4 helpers on three maps.
- Next: navigation down to 3 profiles (ground; flying, collectors included; builders/salvagers over every building) in a fixed per-cluster pool with incremental rebuilds, and the match-start budget scaling every table to stay under 4 GiB.

### 2026-11-02 — navigation: 3 profiles, flying collectors, fixed build slots, fast rebuilds (in progress: NAV_REBUILD_PLAN.md)

- Profiles 11 -> 3 (ground; air, collectors now fly; builders/salvagers of every player over every structure). Edge: navigation 240 -> 87 MB. Flyers' looks: mv.rs look_direct before the shared looks (flow_look_calc 231 -> 125 ms/s after collectors flew).
- Fixed memory: per-profile build slots made at the match's start (flownav.js navReserve; ground 2 x 96 B a tile, builders 2 x their start build + border mines, air 1); destination field pools fixed (routes use the atlas). In-play allocations on the chaos scene: 125 MB/30 s -> 11 KB.
- Rebuild schedule: ~164 ticks -> by simulation step, a stage a step 1-2 steps apart (install in ~6-7 steps); collect waits gone. Edge: main-thread navigation 2.86 -> 0.53 s per 32 s, mean step 556 -> 423 ms (p50 355, p95 686). Sharing between profiles off (memory-neutral with slots).
- Next (NAV_REBUILD_PLAN.md handoff): the whole rebuild as one background chain with the JS glue as wasm kernels (wasm/src/navg.rs written, not built/wired yet), so the main thread only posts and installs (target well under 1 ms a step) and an install lands 1-3 steps after a change at any TPS.

### 2026-11-03 — navigation rebuilds as one complete helper chain

- Completed the NAV_REBUILD_PLAN.md handoff: registered `navg.rs`, removed
  division panic/data-segment paths, aligned arena scratch, rebuilt production
  wasm32 (`21ce5225af2a2064`). One header addresses all arrays through the
  16-stage chain; Rust performs the old JS sizing, components and hierarchy
  glue. Initial/restored builds use the same sequence. The old JS glue is gone.
- Deterministic schedule: install 2 steps after posting at dk >= 3, otherwise
  3. Another dirty profile can wait behind the current one. Overflow skips
  later stages and drops the build; reset/restore collects a pending chain
  before arena reuse. Fixed arena metadata, batched binds, maintained wall
  diffs and an empty-field-window path remove the remaining serial overhead.
  A first fallback-field request still expands that window correctly.
- Final Edge 1M/250k scene, 11 helpers, 40 s: navigation mean **0.393 ms**,
  p95 **0.705 ms**, p99/max **1.080 ms** (only the first of 88 calls above
  1 ms); **29 installs, all 2 steps after posting**, no drops. **0 heap
  allocations and 0 growth** during the measured gameplay window, including
  the sweep scratch now reserved at match start. Slots 323.80 MiB.
- Actual simulation unit-list population 268,662–575,323; 111,932 successful
  spawns; 24,681 research / 32,614 collector / 28,854 astar deposits. The 77
  available whole-step trace rows have p95 499.84, p99/max 535.92 ms, 3 above
  500 ms. This is not a sustained-one-million population measurement.
- Raw results: `tests/test-runs/nav-chain/edge-final.log`, `edge-final-data.json`,
  `edge-final-trace.json`, `edge-final-summary.json`. The earlier Edge run is
  retained too (mean nav 0.979 ms; its field bookkeeping and 16 KB allocation
  led to the final two fixes).
- Serial headless 1M/250k mixed-chaos runs (80 steps, warmup 20, dk1, 11 helpers)
  retain every tick and population/work counter in `baseline.json`,
  `candidate.json`, `final.json` and their JSONL sidecars. Navigation mean/max:
  1.632/14.691 -> 0.321/0.904 -> 0.486/3.420 ms (the last two before the
  final empty-window optimization). Whole-step steady wall p95/max:
  303.41/341.65 -> 265.74/302.32 -> 434.29/495.34 ms; 0 above 500 ms in
  each. **No reliable overall TPS/hitch improvement established** by these
  variable runs. Steady populations ~291k–434k; baseline/candidate work:
  20,436/20,532 spawns, 25,933/25,933 research, 5,813/5,727 collector,
  3,865/3,770 astar deposits. Synthetic warmup still allocates substantial
  memory; that is separate from the measured zero-allocation browser window.
- All-thread profile and neighbor slices retained (`profile.json`, CPU
  profiles, `profile.json.spike-analysis.json`): previous/slow/next/reference
  steps 20/21/22/28 have nav 0.831/0.444/0.014/0.475 ms. Slow step 21 has
  24.21 ms GC, spawning 34.82 vs 9.65 ms in the matching non-burst reference,
  movement 124.06 vs 104.94 ms. Helpers still spend ~0.89 aggregate CPU-second
  per full rebuild, mostly local fields/atlas routes; contention remains
  possible. No build-kernel time was sampled on the simulation thread.
- Validation: six-map chaos determinism with 0/4 host helpers (2,598 hashes
  per map, only the two forced repairs); all navigation tests; memory allocation,
  area-search-range and structure-targeting. New nav-chain-lifecycle covers
  0/3 helpers, overflow guard bytes, arena reuse, fully blocked maps, no heap
  allocations in a reserved rebuild, first fallback in an empty window,
  and repeated pending-chain restores at both boundaries at dk1/4/20.
- Remaining: helper CPU for full rebuilds, serialization of dirty profiles,
  fixed-slot overflow fallback, and whole-step movement/spawn/GC tails.
  Detailed implementation and measurements are at the end of NAV_REBUILD_PLAN.md.

### 2026-11-03 — Full-run failures and bounded WASM32 matches

- Stopped `tests/test-runs/full-20261103-background` with its STOP marker;
  original results remain historical: 557 passes, 23 failures/timeouts and
  one stopped balance job. Follow-up logs stay under that run's results.
- Match limits now account for full worker/status/AI reservations, every
  permitted owned-building class, neutral mines and gameplay headroom.
  Explicit building overrides cannot bypass capacity. Starter buildings
  respect the cap; oversized imports fail with the actual applied limit.
  Fixed worker-brain reserve arguments and explicitly release replaced
  hit/AI arrays; loading drains retired setup allocations before play.
- Per user direction, maximum map size is now **1024×1024**, including the
  dropdown, configuration application, network startup and scene import.
  Highest selection allows 1,048,576 total units: 524,288 each with two
  players or 131,072 each with eight. Building limits are respectively
  32,768 or 8,192 each. Lower selections remain upper bounds. WASM32 remains
  the default and the heap limit stays 4 GiB.
- The rejected 2048 workaround lowered eight-player population to 4,096
  each; that is not the supported solution. Allocation-site inspection of
  2048 with only 8 units/64 buildings per player and no mines measured
  3,712 MiB live after 20 ticks: navigation slots 1,143 MiB, effective-area
  histogram 309, acquisition 311, spatial indexes 290, worker reservations
  192, traffic 176 and area boxes 151. A duplicate 96 MiB worker reservation
  allocation is now reused on cache reset. Remaining memory reductions are
  deferred. Raw attribution: `results/memory-baseline.json`.
- Large test fixtures select actual menu values and derive production
  capacities. Historical crowd scenes are reduced proportionally by team
  and profession, with the before/after counts retained. Move commands use
  the real per-action ID limit. Balance generators split their former
  2000-square matchup grids into supported maps, retaining all pairings.
- Updated obsolete API/default/order assertions and multiplayer work
  counters to observe WASM events. Fixed GPU timer ownership when renderer
  and benchmark queries share a context, and allow one-channel readback
  rounding in strip comparison. The original intermittent motion failure
  has not reproduced in the first browser rerun; its assertions remain.
- Verification and final serial measurements are recorded below when the
  follow-up run completes. These are capacity/correctness changes; fixture
  populations differ, so they do not establish a TPS improvement.

### 2026-11-03 — resumed capacity validation and fixture regeneration

- Resumed the prior session's validation. The regenerated manifest has 234
  equal-number fight parts, 354 equal-energy fight parts and 3 worker scenes,
  all targeting 1024-square maps. Fight imports passed in both worker modes.
  The scenario benchmark caught stale 2000-square worker exports; regenerating
  them retained all 200 groups and 6,960 starting units in each research scene.
  The worker/fight benchmark smoke then passed. Regeneration commands are now
  documented together in `tests/balance/README.md`.
- Added regression checks for worker-export dimensions and entity coordinates,
  and exact level/opponent coverage across fight parts (including duplicates,
  rather than only total matchup counts). Fixed a duplicate `error` declaration
  in the LOD strip test left by the previous readback-tolerance edit.
- The resumed serial validation list has **49 passing jobs**, including the
  34 mode-specific regressions, six sampled fight imports per worker mode,
  benchmark smokes, eight-team capacity, and retained workload measurements.
  The strengthened coverage checks passed in both modes. The expanded smoke
  restored and ticked all three worker scenes, an equal-number fight, and the
  last numbered part of an equal-energy laser fixture.
  Raw commands, logs and results remain under
  `tests/test-runs/full-20261103-background/results/final-validation/`.
- Retained large mixed-chaos measurement (production WASM32, 11 helpers, dk1,
  140 steps, first 20 separated): 1,000,004 starting units and 65,536 structures;
  steady measured population **298,609–506,901**, 8,480 births / 218,388 deaths.
  Successful work: 8,553 spawns, 7,694 research / 1,235 collector / 897 astar
  deposits. Steady wall p95 **206.34 ms**, p99 **238.20 ms**, max **307.15 ms**,
  zero above 500 ms. The **first gameplay step is 3,103.48 ms**, and all-step
  p99 is 542.61 ms; early gameplay spikes remain in the raw JSON/JSONL and
  must not be hidden by steady-window statistics. Unit slots stayed 1,150,976.
  These are retained acceptance measurements, not a new A/B TPS comparison
  or sustained-million-population result.
- Browser tests exposed a real first-use/resize rendering error: the small-unit
  claim pass captured the previous framebuffer after allocating and binding its
  own target. The next sprite draw sampled that same target, causing a WebGL
  feedback loop. `drawUnitClaims` now captures the scene target before allocation.
  `claim-framebuffer-restore.test.cjs` verifies first use, reuse and resize with
  both R8 and floating-sum targets. The corrected strip test passed; native GL
  warnings and optional call-level audits are now captured by the browser tests.
- **All four browser checks pass:** population/map menu, frame stability, LOD
  strips and the full 20-view LOD run (400,000 starting units, 60,262 structures,
  1024 map). Every LOD view reports zero GL errors; no native GL error warnings
  were captured. Raw final LOD data and screenshots are retained as
  `results/lod-final.json` and `results/lod-final-{2d,3d}-3.png`; the failed full
  run and timer audit remain separately for attribution. Status and source
  hashes are in `results/resumed-summary.json`, browser commands/logs in
  `results/browser-fixes.{cjs,json}`. The sandbox could not launch Edge;
  browser verification used authorized headless runs outside it.
- Further memory reductions remain deferred by request. The 1024 menu/runtime
  cap and the existing navigation/movement/spawn/GC bottlenecks are unchanged
  by this validation work. The framebuffer fix changes rendering only.

### 2026-11-03 — settled checkerboard action and released-slot spikes

- Focused acceptance on gameplay after **60 settling ticks**, with recurring
  rally, queue, research, movement, attack and construction bursts enabled.
  Profiling starts at tick 59 so the previous tick is captured too. No
  gameplay ticks are discarded or advanced as loading preparation.
- `nfs.rs k_slot_zero` now resets one column across a job's freed slots,
  hoisting metadata/default conversion and using typed stores for scalar
  columns. It previously traversed hundreds of columns and used a
  variable-size memset for every scalar of every freed slot. Defaults,
  strided tails and allocator reuse order are retained.
- `uix.rs k_uid_clean` probes the existing numeric unit-ID table and removes
  duplicate action IDs using the existing slot stamps. `_actionCleanIds`
  validates input numbers and feeds bounded chunks through reserved order
  scratch; results retain input order and the distinct-ID limit. Loose units,
  page views and small lists use the scalar path. No per-action WASM buffer
  allocation was introduced.
- `simMatchPrepare` runs world-dependent ID/upkeep/wall/area-box preparation
  during match loading, scene import and full snapshot restore. Slot-list
  collection and ID-index refill iterate the resolved units view instead of
  repeatedly entering the proxy. Preparation does not advance time, consume
  queued actions or run production/worker decisions. The benchmark invokes
  the same preparation after its synthetic placements and records `prepareMs`.
  This is separate from the gameplay improvement below; substantial first-use
  AI/stat work still appears in the retained early ticks.
- All-thread attribution is retained under `tests/test-runs/spikes-20261103/`.
  The initial profile's previous/slow/next/reference ticks 19/20/21/40 showed
  released-slot reset at **24.50 vs 14.43 ms**, with ~260 aggregate CPU-ms
  on the slow tick. A later named profile, after slot-reset optimization but
  before native action cleaning, compared ticks 59/60/61/80: action handling
  **51.12 vs 34.16 ms**, including **10.50 ms GC**; movement **62.84 vs
  57.21 ms**. It identified ID cleanup/lookup on the simulation thread.
- Final **unprofiled**, serial pair: production WASM32, 11 helpers, dk1,
  1024 map, 1,000,004 starting units and 65,536 structures, 160 ticks with
  ticks 60–159 measured. `settled-baseline.json` and `actions-final.json`
  retain raw ticks, GC/process metrics and JSONL sidecars:

  | Settled metric | Baseline | Candidate |
  | --- | ---: | ---: |
  | Whole-step wall p50 | 109.67 ms | 107.23 ms |
  | Whole-step wall p95 | 152.43 ms | 145.39 ms |
  | Whole-step wall p99 / max | 193.55 ms | 169.00 ms |
  | Slow ticks above 500 ms | 0 | 0 |
  | Ticks above 1.5× own median | 2 | 1 |
  | Action-burst mean / p95 | 35.06 / 46.62 ms | 27.85 / 36.41 ms |
  | Freed-slot reset mean / p95 | 1.82 / 6.53 ms | 1.18 / 4.62 ms |

- Both measured windows have **285,529–375,694 units**, 7,541 births and
  98,325 deaths. This is a scene seeded with one million units, not a sustained
  million-unit measurement. Work in those 100 measured steps matches exactly:
  7,541 spawns (5,416 army), 1,996 research / 891 collector / 829 astar
  deposits, 543 completions, 1,260 healer deliveries and 44 salvage returns.
  Actual measured-wall throughput: spawns **667.0 → 689.5/s**, research
  **176.6 → 182.5/s**, collector **78.8 → 81.5/s**, astar **73.3 → 75.8/s**.
  Both final exact state hashes are **338091ed**. `summary.json` derives the
  window-specific work and comparison; future benchmark outputs include
  `population.steadyWork` and `workPerWallSecond` directly.
- Earlier 100-tick captures remain, including the noisy `final.json` run
  (435 ms max) and the reversed-order baseline repeat. The settled pair shows
  **4.6% lower p95 and 12.7% lower max**, not a guarantee against OS/GC tails.
  There are only ten action bursts in that pair; their p95 is their maximum.
- Final production all-thread capture `retained-profile.json` starts profiling
  at 59 after settling. Previous/slow/next/reference ticks **59/60/61/80**:
  wall **115.87/162.96/130.52/141.44 ms**; slow/reference action handling
  **39.90/25.30 ms**, GC **10.20/0 ms**, movement **55.30/51.60 ms**.
  Both whole-step and `processActions` neighboring-thread slices are saved.
  Movement remains the main normal cost (~58.5 ms/step in acceptance): traffic
  occupancy/shoulders/swaps and atlas looks. Residual burst costs include
  arrival marking/ID lookup, released slots, worker-search waits and GC.
- Validation: **15 serial jobs pass**, covering native/scalar cleanup
  equivalence (including malformed IDs, caps, duplicates across chunks, loose,
  dead and removed units, stamp rollover), slot defaults/guards/strides with
  three helpers, unchanged loading state/time/queues, spawn columns, slot
  reuse/locality, action budgets/supersession, orders, production and scene
  engagement in page/worker modes. Dense chaos replays match with 0/3 helpers.
  Six-map multiplayer determinism passes with 0 and 4 host helpers (2,598
  compared tick hashes per map, only forced repairs). Three-peer checkerboard
  transport with 3/0/2 helpers passes **378 exact peer/tick comparisons**, 14
  collision bursts and all 30 gameplay actions, with no repair.
- Rebuilt WASM32 **fe9b00468529f587** and WASM64 **a2034c4867cfe8d5**.
  Native cleanup, slot-reset and loading-preparation checks also pass on
  WASM64. Raw validation logs/results and source hashes are retained alongside
  the measurements. Timing comparisons were serial and separate from builds,
  correctness runners and profiled captures.

### 2026-11-07 — perf-fuzz spikes on the 1M chaos scene (open)

- 60-minute perf fuzz (headless Edge, re-exported 1M-unit / 65,536-structure
  scene): no page errors or stalls, but 72 of 113 trials flagged. The worst are
  tick stalls of 2-5 s from q / e on big selections (per-unit JS spawning +
  one occ_spawn search per new unit), 1.8 s after stop/hold of 115k units,
  0.85 s from a box select at 478k units, and the end-of-tick watched-unit
  details doing a full units scan. Page: selection index/markers/id lists
  per frame, effects lookups, frame apply. Details, evidence and directions:
  [PERF_FUZZ_SPIKES_2026-11-07.md](PERF_FUZZ_SPIKES_2026-11-07.md).

### 2026-11-08 — q / e (S1) as batch wasm kernels, unit births without JavaScript

- Plan, stages and numbers: [UNIT_BIRTH_WASM_PLAN.md](UNIT_BIRTH_WASM_PLAN.md).
  Probe: `node --max-old-space-size=14000 tests/resize-spike-probe.cjs <scene.gz> [helpers]`
  (`STAGES=1`: wall per kernel; x2 / d2 / x2 on every combat unit of player 0).
- q / e is now parallel kernels (wasm/src/birth.rs): look / plan / scatter
  over the selection (d2 kills in the scatter), block placement (per block a
  64-bit-row fit map of the footprint, bit-parallel ring search, exclusion
  spans per placement, two rounds), k_birth_alloc (the only serial pass:
  slots, handles), k_birth_fill (rows, footprints, handle table, id table,
  id hash by compare-exchange, the template's type columns copied),
  k_slot_zero, k_spawn_write (core), k_rz_shares (closed-form stacks /
  levels / energy water fill), k_spawn_spatial, k_upk_bins. No per-unit and
  no per-group JavaScript; no stat programs; no column growth (births
  bounded by the reserved slots).
- Unit objects are lazy (SimOwners.at makes them); the handle stack is a
  heap array; the slot allocator is Rust (nfs.rs k_slab_take, also used by
  single births; the JS allocator is gone); dead units' reference fields are
  released at death.
- A determinism bug of the interim version (first unit of a group through
  the JS spawn path only when the peer's stat-program cache missed: ids
  swapped on a repaired guest) was found by multiplayer-chaos-determinism
  and removed with the JS path. That suite passes with 0 and 4 host helpers
  (2,598 tick hashes per map, only forced repairs); unit-resize-kernel now
  also checks new units' type columns against kept units.
- chaos-1m-250k (Node 24, 11 helpers): x2 of 239k selected (224k new units)
  225 ms (2-5 s in the Edge fuzz for 80-170k); x2 of 205k 150 ms; d2 of 423k
  109 ms. mixed-200k: x2 of 39k 63 ms first / 42 ms after.
- Left (largest first, 224k births): reused-slot zeroing 44 ms (zero freed
  slots on a background lane instead), placement 29, k_birth_alloc 8-30,
  k_spawn_spatial 23 (serial), k_birth_fill 15-22, k_uid_clean 9-17, look
  4-8. Helper binding stalls (a rebind before a parallel job runs it on the
  simulation thread alone) need a shared-memory pointer table. Worker
  subgroups make no new units on x2 yet (worker records not in wasm).
  S2-S10 of the fuzz report are untouched.

### 2026-11-08 (later) — q / e staged: snapshot at the action, lane, flat commit a tick later

- User rule: stable tick time whatever players do; a tick or two of delay is
  fine. q / e now records and groups at the action's tick, does placement /
  slot assignment / zeroing on lane SIM_LANE_RZ, and commits at the end of
  the next tick with parallel flat writes (UNIT_BIRTH_WASM_PLAN.md "Staged
  q / e" and its status list: the bugs found on the way and their fixes).
- chaos-1m-250k (Node 24, 11 helpers; normal ticks 110-250 ms): x2 of 239k
  selected made 224,914 units (was 2-5 s stalls); its ticks 92 / 214
  (commit 84 ms + lane wait 40 ms) / 187 / 112 / 155 ms; a second x2 of 206k
  selected 149 / 121 / 120 / 120 / 202 ms (commit 38 ms); d2 of 418k
  98 / 196 / 162 / 87 / 126 ms.
- Correctness: unit-resize-kernel (type columns, slot books, occupancy),
  unit-resize-staged-snapshot (a pending job through a snapshot),
  multiplayer-chaos-determinism with 0 and 4 host helpers, checkerboard
  chaos with 3/0/2 helpers (524 clean comparisons), slot / spawn / storage
  tests: all pass.
- Left: the commit's kernels at 225k births (~66 ms: footprint check 14,
  fill 18, core rows 12, shares 9, spatial 8) and the lane not done by the
  commit on a first use (40 ms wait): spread the commit over ticks by block
  or give the lane two ticks; d2's per-unit JavaScript retire pass; the
  action tick's scatter (38 ms cold / 7 warm) and id cleanup (9-16 ms);
  worker subgroups (no new units yet); a restore after different histories
  diverges without q / e too (pre-existing).

### 2026-11-08 (later still) — q / e commit over ticks, retire pass release as a kernel

- The staged q / e's commit runs in 4 sub-commits by block, one a tick,
  then a final step (shares, kills, slot books); the lane gets a whole tick
  before the first. Snapshots carry a job in its commit steps. The retire
  pass's per-removed-slot release (simUnitStateDetachGone, ~20 calls a
  unit) is now simUnitStateDetachGoneMany: one kernel (nfs.rs
  k_retire_release) plus a tight JavaScript loop only for existing objects,
  the pending path list and the two handle-kept references. Details and the
  three bugs found on the way: UNIT_BIRTH_WASM_PLAN.md.
- chaos-1m-250k (Node 24, 11 helpers; normal ticks ~90-160 ms in the run):
  x2 of 239k selected 88 / 132 / 162 / 111 / 156 / 102 / 163 / 98 ms (was
  92 / 214 / 187 / ...); d2 of 401k 97 / 136 / 205 / 146 / 97 / 98 / 137 / 90
  (was 98 / 196 / 234 / ...); a second x2 of 180k 85 / 74 / 133 / 104 / 107 /
  103 / 114 / 90.
- Tests: unit-resize-kernel, unit-resize-staged-snapshot (before and in
  the commit), unit-retirement, status-expiry-records, slot tests,
  multiplayer-chaos-determinism with 0 and 4 host helpers, checkerboard
  chaos 3/0/2 helpers (524 clean): pass.
- Left: d2's mass retire (~+60 ms on one tick: k_unit_gone serial ~13-25
  ms, the retire loop, objects of units made by JavaScript paths), the
  action tick's scatter/id cleanup at first use, worker subgroups, the
  pre-existing restore-over-own-history divergence.

### 2026-11-08 (night) — object-free unit release, parallel gone pass, watched details by id

- Unit objects no longer decide anything at a death. Every handle goes back
  on the free stack at once (the same on every peer, whatever objects a
  peer made: an earlier step kept handles for live objects until a
  FinalizationRegistry gave them back, which made handle reuse depend on GC
  timing and on page-made objects). A per-handle flag byte (S.hobj: 1 has
  an object, 2 holds a by-handle reference) lets nfs.rs k_retire_release
  list only the flagged ones as (handle, slot); the JavaScript writes the
  last id / owner / position onto those few objects, sets their handle to 0,
  and clears their by-handle references. Unit.prototype._us reads the
  columns while the handle names a slot. The per-handle gone tables
  (hgId/hgOwn/hgX/hgY, 16 B a handle) are gone.
- The retire pass's gone kernel runs in parallel (ord.rs k_unit_gone_par:
  chunks of 4096, shared counts by atomic adds, occupancy bits by atomic
  AND, ordered outputs per chunk merged in chunk order).
- simFrameDetails (S4): a watched unit not at its slot is found through the
  id index (O(1)) instead of a scan over every unit (up to 512 x 480k reads
  a tick).
- chaos-1m-250k, Node 24, 11 helpers, normal ticks ~90-135 ms in the run:
  - x2 of 182k: 89 / 96 / **175** / 141 / 93 / 112 / 111 / 147 ms. The 175
    is the commit tick waiting on the lane (simParallelBackgroundWait 69 ms
    + rzCommitDue 60 ms): open.
  - d2 of 319k: 101 / 102 / 107 / 134 / 95 / 92 / 91 / 126 (retire pass on
    the kill tick 49 ms, was 89-152).
  - stop 147k: 89 / 88 / 95 / 108 / 98 / 82 / 86 / 116; hold 137k: 73 / 71
    / 71 / 80 / 74 / 67 / 67 / 73; stop 129k: 82 / 67 / 70 / 67 / 73 / 77 /
    75 / 71. No sim-side spike from stop / hold (S2's 1.76 s gap in Edge is
    not in the simulation tick here: page or worker messaging, to check in
    Edge).
- Tests: unit-gone-objects (new), unit-resize-kernel,
  unit-resize-staged-snapshot, unit-retirement, slot-zero, slot-relayout,
  slot-locality, status-expiry-records, unit-spawn-columns,
  multiplayer-chaos-determinism with 0 and 4 host helpers, checkerboard
  chaos 3/0/2 helpers (524 clean): pass.
- Left: the x2 commit's lane wait; the d2 kill tick's retire pass (49 ms
  for 319k removals); stop / hold's JavaScript fallback after k_unit_cmd
  (when the id index has loose entries) still exists; S2 in Edge; Edge
  check of S4.

### 2026-11-08 (night, later) — slots made fresh at release on a lane; no clearing at any birth

- The x2 commit tick's stall (175 ms) was the commit waiting on the q / e
  lane, whose biggest stage was clearing the birth slots (k_slot_zero over
  the births: 158 ms CPU, per column over a list of scattered slots) next
  to the placement (141 ms over 16,900 block chunks); its chunks also
  pushed the flow lane past its commit (28 ms wait).
- Slots are now made fresh when let go, not when taken. The retire pass's
  slots (dead, not live: what every pass reads as no unit) go to a new
  background lane, SIM_LANE_FREE (lane 15; control words moved past the 16
  lanes): k_free_mark sets a bit a slot and lists the touched 4096-slot
  blocks (one job); k_free_zero takes a block a job and, column by column,
  per 32-slot word of bits, fills a full word as one contiguous slice and
  a partial one by its set bits (trailing zeros): one or two cache lines a
  word, no false sharing (blocks are disjoint). The batch goes back on the
  slab books at the next release call (one more a call per 65,536 slots).
  So every slot on the books is fresh: no birth clears anything. Removed:
  simUnitStateAllocate's per-spawn k_slot_zero call and its JavaScript
  fallback (_simSlotZeroFn), q / e's zeroing stage on the lane and in its
  restore, the k_rz_bzero variant.
- The lane leaves the core columns (unit.js _SPB_CORE / _SPB_FINAL: id,
  owner, position, levels, targets, handle, dead flags, energy) and
  live / tmOn alone: every birth writes them (its spawn row), and the tick
  after a death still reads a released slot's position / energy / id
  (resetting them on the lane made a 0-helper host diverge from helper
  guests). The single-unit path (simUnitStateAllocate: the Unit
  constructor, repairs) resets the core itself, straight-line stores.
  q / e's failed births no longer get their row written (k_rz_crank marks
  the row skipped): their slots go back untouched.
- Released slots carry 156 columns, 477 bytes a slot. CPU (0 helpers):
  the free lane 234 ms over all deaths in the x2 run (was 487 ms with
  per-run fills), 144 ms for d2's ~188k kills plus battle deaths; on 11
  helpers ~13 ms wall, off the foreground.
- chaos-1m-250k, 11 helpers (normal ticks 77-172 ms in this run): first x2
  of 182k 124 / 101 / 154 / 180 / 133 / 124 / 116 / 170 (no RZ lane wait;
  +2 has rzCommitDue 43 ms cold and a 26 ms flow-lane wait, +3 a 33 ms
  index wait); d2 of 317k 142 / 118 / 113 / 135 / 125 / 93 / 137 / 113 (the
  kill tick's retire pass 52 ms); second x2 of 146k 88 / 126 / 119 / 128 /
  124 / 140 / 157 / 165.
- Tests: slot-zero, slot-locality and slot-relayout (call the release twice:
  the slots come back at the next call), unit-gone-objects,
  unit-resize-kernel, unit-resize-staged-snapshot, unit-retirement,
  unit-spawn-columns, status-expiry-records, multiplayer-chaos-determinism
  with 0 and 4 host helpers (6 maps), checkerboard chaos 3/0/2 (524 clean):
  pass.
- Left: the first commit's cold cost and the flow / index lanes it delays;
  the d2 kill tick's retire pass (52 ms); the free lane writes 156 columns
  a dead slot (columns every birth overwrites could be left out, birth path
  by birth path); the slab-free loop at the return is JavaScript per slot.

### 2026-11-08 (night, last) — idle tick variance: deaths O(1), flow looks by size, nothing allocated in the death path

New probe: tests/tick-variance-probe.cjs (idle ticks of a scene, per phase
mean / min / max / correlation with the tick, page faults, direct kernels,
background waits by lane and which lanes were busy, the wasm heap's
allocations in play (simHeapPlayMark), HEAPPROF=file a sampling heap
profile of the JavaScript allocations). chaos-1m-250k, 536k units, 11
helpers, Node 24.

- Start: ticks 76-140 ms (mean 96, p95 138). The slowest were battle-death
  ticks: the retire pass up to 43 ms with ~6,300 page faults, of which
  k_retire_release 26-33 ms serial (the pooled reference fields reset per
  dead slot) and ~20 ms of JavaScript writing to the dead units' objects
  (every unit had one: restore and production spawns make them, 38k on a
  tick); the flow looks' commit waiting 15-26 ms every 20 ticks; the free
  lane's return waiting up to 16 ms.
- Deaths touch no JavaScript object: per handle a generation (unit.hgen)
  and a gone record (unit.hg: id, owner, x, y, AoS), written by the release
  kernel. Unit.prototype._us and _gone* read them; SimOwners.at makes a new
  object when the generation moved on; the by-handle references
  (attackTarget, _fpPath) keep the generation they were set at and read as
  unset after. Gone: the per-handle flag byte, the flagged list, the
  object loop.
- k_retire_release no longer resets the pooled reference / object fields
  (the free lane does, with the slot's other columns), and runs in
  parallel from 4,096 removed slots (k_retire_release_par: chunks of 2,048
  write their slots' handle, generation, record, worker / status records
  and list what they free; one merge appends the lists in chunk order, the
  serial order). Its buffers (handle free stack, pending paths, the
  chunks' scratch) and the relayout's index scratch are made at match
  reserve for every slot; nothing in the death path allocates or grows.
- Free lane: due two calls after its post (no return wait seen since).
- Flow looks: a job's commit is a tick later per 131,072 looks it lists
  (the 1 Hz burst lists ~185-215k against 30-110k on other ticks); while
  one is in flight none is posted. No flow wait since; flow-looks-commit
  (0 vs 3 helpers the same, 85k exact / 37k approximate): pass. The fl.*
  buffers are sized for every slot at their first make. (Posting every
  second tick instead lost the answers: 37k exact / 87k approximate.)
- Now: ticks 74-127 ms (mean 95, p95 120) on three runs; one run had a
  185 ms tick. The wasm heap: no allocation in 40 ticks of play. The
  JavaScript heap: ~0.5 MB a tick (14.4 MB sampled over 30 ticks: damage
  visuals, direct kernel calls' argument arrays (structStatusTick), the
  hits pass, spawn objects, towers, sorts...): the GC behind the outlier.
- q / e and orders now (ticks after): first x2 of 182k 80 / 96 / 154 / 144 /
  132 / 129 / 123 / 125 (cold); d2 of 316k 115 / 105 / 150 / 119 / ...;
  second x2 of 145k 95 / 97 / 108 / 95 / 93 / 108 / 106 / 105; stop of 271k
  97 / 90 / 88 / 99 / ...; hold 99 / 84 / 78 / ... The action's own
  processActions: x2 64 ms, d2 29, stop 88, hold 41 (a foreground cost of
  its own).
- Smoke tests between changes (unit-gone-objects, unit-retirement, slot
  tests, unit-resize-kernel / staged-snapshot, unit-spawn-columns,
  status-expiry-records, flow-looks-commit, slab and occupancy audits after
  each profile): pass. Determinism suites not run since the generation
  change (left for the end, once ticks are stable).
- Next: the JavaScript allocations per tick (no GC in play); the action
  ticks' own cost (stop 88 ms, x2's scatter); the first x2's cold commit;
  simMoveRun's 31-56 ms by battle load; the retire pass on battle waves
  (up to 24 ms); the relayout step (0-18 ms on odd ticks) to a lane;
  objects out of production spawns and the restore.

### 2026-11-08 (night, last+1) — orders on many units in parallel

- An order's per-unit writes (stop, hold, attack, kill: k_unit_cmd) were
  one serial kernel: 45 ms for 216k ids. Now from 8,192 ids
  uix.rs k_unit_cmd_par: chunks of 4,096 (a slot's dedupe by an atomic swap
  of its stamp) write every slot, and list the slots whose paths are let go
  and the stopped workers; one merge, in id order, pushes the movement
  paths to their free stack, releases the stored paths (shared, refcounted
  blocks) and lists the workers: the serial kernel's result. Its buffers
  are made at match reserve for every slot (unitCmdReserve).
- chaos-1m-250k, 11 helpers: stop of 216k: action 67 -> 21-25 ms (the
  kernel 1.9 ms); hold of 160k 12 ms; stop of 140k 9 ms; move of 127k
  10 ms. Ticks after: within the scene's range.
- What is left of an order's cost: its id pipeline (sanitizeAction:
  _actionCleanIdsInto and _actionIds32, JavaScript loops over the ids, a
  new Int32Array an action; k_uid_clean, serial, ~5-10 ms).
- Tests: unit-cmd-kernel (the kernel = the setters over 40 steps),
  unit-retirement, status-expiry-records: pass.

### 2026-11-08 (night, last+2) — order ids on the wire path; q / e off for now

- The probe now sends an order as a peer gets it (ids as uidz, through
  JSON, prepared before the tick by actionsPrepare). On that path an order's
  tick cost is small: stop of 216k 0.4-5.4 ms (prepare 2.5 ms, before the
  tick), hold 0.6, move 2.7, d2 5.8. _actionIds32 takes a decoded Int32Array
  as it is (was copied id by id). The plain-list path (tests, tools) still
  cleans in JavaScript and k_uid_clean.
- q / e (x2 / /2, resizeUnitGroup) is switched off (main.js
  UNIT_RESIZE_ENABLED = false): no Q / E / * / / keys, no x2 / /2 buttons in
  the info panels (hud.js, info_panel_static.js), the controls row gone from
  the settings (index.html), the action ignored by the simulation on every
  peer, its buffers not reserved (rzReserve). The staged implementation
  stays for later; open there: the placement lane starved when ordered
  after the traffic lane (k_rz_place now takes 64 block jobs a chunk, built,
  not measured), the first commit's cold kernels (bindings now made at the
  action's tick: still 2-4x on the first step), the action tick's scatter
  (RZ_PER 4096: 25 -> 5-15 ms), commit due a tick later per 65,536 births.
  unit-resize-kernel and unit-resize-staged-snapshot skip while it is off;
  multiplayer-scenarios checks the split / merge only when on.
- Also: the lane order puts FREE and RZ after TRAFFIC (the traffic wait on
  an x2's commit tick went from 12 ms to none); heap pages prefaulted at
  the end of simMatchReserve (simHeapPrefault).

### 2026-11-08 (night, last+3) — S3: the page had no structure table (two regressions of the object-free units)

- Edge, tests/select-all-spike-probe.cjs on chaos-1m-250k (headless, RTX
  2060 through ANGLE; new options: R3D=1 build3DFrameData's phases, PROF=file
  a page CPU profile of the calm window, INSPECT=expr, CONSOLE=1 the page's
  and workers' console errors). Before: every page frame ~420 ms (2 FPS),
  build3DFrameData's structure phase ~385 ms a frame: every structure
  (22k towers, 11k barracks, 12k spawners, 43k floor items) through
  _reuseStatic3DObject / get3DExact2DVisualSignature, the page's own
  restored objects, because _pageTables.s (the structure table) never came.
- Cause 1: Unit.prototype._det was a getter only (this session's move of the
  unit fields to the prototype): a write to _det threw in the worker and
  the presentation ("Cannot set property _det of #<Unit> which has only a
  getter"), the presentation's metadata cycle stopped, the page got no
  presentation frames at all. Fixed: the accessor's setter defines an own
  field.
- Cause 2: with x2 / d2 off, the info panel's static update still showed
  B.x2 / B.d2 (undefined): a render error every few frames. Fixed.
- The presentation's first metadata cycle now runs whole at
  simPresentationStart (a match's start, a restore, a resync): in 1 ms
  slices between ticks it would take minutes at this scale before the page
  had its structure table.
- After: frames p50 8-17 ms, p95 33-100 ms, max 100-150 ms through box
  selects of 106-120k units + 16-18k structures and their orders (was 847 ms
  in the report, ~420 ms a frame in the first runs here); the structure
  phase 17 ms over the whole run; the info pack 8-10 ms.
- Open: page long tasks of 100-150 ms around selects / orders (S5); the
  first simulation ticks after a restore (365-1,404 ms; tick 4's waiTake
  280 ms): one-time work to move before the start; sim ticks in Edge p50
  153 / p95 276 ms at ~200k units.

### 2026-11-08 (night, last+4) — far effects without unit lookups; structure metadata in parallel

- Page, rounds of box select + order on chaos-1m-250k (Edge): the largest
  page cost was the combat effects' per-record lookup of both ends' drawn
  positions (pageUnitDrawnAt 3.5 s + _pushCombatRecordFx 2.8 s of 31 s).
  Effects far away (under _FX_FAR_PPT pixels a tile: dots and lines) keep
  the record's positions (effects3d.js): the difference is under a pixel.
  Still on the page: _simClientUpdateStableSlots (a pass over every slot's
  id per new frame, PageUnit births / freezes), paintMinimapUnitColumns,
  _freeze, keep (S5).
- Simulation worker in Edge (profiled over a CDP session attached to the
  worker, tests/select-all-spike-probe.cjs WPROF=file): k_meta_structs, the
  presentation's structure rows, was one serial call over ~88k structures
  between ticks (891 ms in 28 s). Now from 8,192 slots nfs.rs
  k_meta_structs_par: rows in chunks of 4,096 (their ordered outputs:
  gone, order, cooldown misses into chunk scratch), one ordered merge, then
  the laser links in chunks. tests/meta-structs-kernel.test.cjs PAR=1 runs
  the whole cycles that way on 3 helpers against the reference: pass.
- Edge ticks now (~200k units, after the first 10): p50 155, p90 211, p95
  226, max 455 ms. The slow ones: unitEventsRun (to 76 ms), unitHitsResolve
  (to 86), projectilesAdvance (to 65), _simPostResult (to 34),
  healerCandidatesStep (27), recalculateUnitEffectiveLevel (24), on top of
  simMoveRun 56-155.

### 2026-11-08 (night, last+5) — tick variance in Edge: research views kept, the variance ranking

- The worker's trace (?simtrace=1) now also times every parallel kernel by
  id (kp:<id>), the background waits by lane (w:<lane>) and the result's,
  events' and retire pass's parts (sim_worker.js SIM_TRACE_FNS). New ranking
  tool: share of the tick's variance each phase explains (cov / var).
- Helpers: 11 / 8 / 6 (?simhelpers=) gave p95 265 / 258 / 241 ms on the same
  scenario: oversubscription is not the main source.
- simFrameEncodeState (the worker's per-tick state for the page) spiked to
  41 ms every 10th tick: the research queue's views (~1,450 tasks a
  player) were dropped at every finished research (the stats version was
  part of their cache key) and remade with every task's cost and work.
  Now a stat change rebuilds the order and levels only (cost and work are
  the stat's and level's alone, from THING_STATS), objects made anew only
  at a restore; each stat's level read once a rebuild; a kept task's cost
  not recomputed. Encode on those ticks 11-41 -> 2-7 ms (node, chaos-1m).
  _simLevelsEncode also diffs one level of nested maps (researchLevels:
  thing -> { stat: level }) instead of deep-copying the whole map.
  research-queue test: pass. (sim-frame-replica fails: "k_slab_take: no
  wasm kernels on this thread", a test without wasm: open.)
- Edge ranking now (share of tick variance): simMoveRun 27% (of it the
  occupancy movement kernel 14%, the movement kernel 7%), projectiles 9%,
  unit events 9%, worker search tier 8%, spawner queue 7%, retire 6%, hits
  6%, relayout 5%. Kernel 89 (MOVE_OCCUPANCY) 41-109 ms in Edge against
  17-29 ms in Node on the same scene: likely stragglers (a helper late
  into a foreground job). Next.

### 2026-11-08 (night, last+6) — the movement's variance is one job: the heaviest occupancy block

- Tracing (?simtrace=1) now also records per parallel kernel this thread's
  wait for the job's last chunks (tail:<id>), the chunk count (n:<id>), the
  longest single chunk over every thread (chunkMax:<id>; shared control
  words SIM_PAR_TRACE_ON / SIM_PAR_TRACE_MAX, sim_parallel.js), and the
  bindings changed in the tick (binds, bindNames).
- Edge, chaos-1m-250k (~200k units): kernel 89 (MOVE_OCCUPANCY) 42 / 54 / 71
  ms (p50 / p95 / max) with ~850 chunks; its tail wait 1.7 / 9.7 / 20.5 ms
  correlates 0.77 with its time; its longest chunk 6.6 / 12.8 / 20.0 ms
  against ~0.6 ms average. Kernel 8 (MOVE): longest chunk to 27 ms. The
  bindings do not explain it (52 of 230 ticks rebind, mostly navigation
  builds' nav.* swaps; correlation -0.01).
- Cause: the occupancy movement runs one job per 16x16-tile block (colour
  phases so a phase's blocks touch disjoint cells, heaviest first): a dense
  battle block is one long job and its phase waits for it. The block size
  has a floor of 16 tiles (sim_occupancy.js, SIM_OCCUPANCY_BLOCK_TILES and
  Math.max(16, ...)), tied to how far a unit may reach past its block in a
  phase (simDk steps): smaller blocks or splitting a heavy block's units
  needs that halo rule worked out first. Next.

### 2026-11-08 (night, last+7) — the "dense block" was headless Edge: the occupancy jobs measured

- Per job of kernel 89 its time and its block's units (trace-only: par.ctrace,
  sim_parallel.js _simParTraceChunk; tests/occ-sched-probe.cjs in Node, which
  also simulates schedules from the measured job times; the worker's
  ?simtrace=1 now adds cpu:89 and slow:89 [ms, units], and the simulation
  thread's background help chunks bgc:<lane>:<kernel> / bgcMax:;
  tests/occ-edge-trace-probe.cjs reads them in Edge).
- Node, chaos-1m-250k, 11 helpers: ~3,625 jobs a tick, a job ~8 us fixed +
  ~0.4 us an index entry (474k entries a tick), 231 ms of job time a tick,
  the kernel 17.5-24 ms. The four colour phases' barriers cost ~1 ms: a
  dataflow schedule (a block waits only for its lower-phase neighbours, by
  claim order or a ready queue) simulated from the same times gives 18.8 /
  22.8 ms p50 / p95 against 19.7 / 23.3; work / threads is 18.8 / 21.8. The
  dependency chain is 2-9 ms: no block dominates. Slow jobs (1-7 ms) have
  any unit count (7 units, 2.8 ms) and hit 2-5 threads at once: stalls.
- Edge headless (the earlier numbers): 2,053 jobs over 2 ms in 160 ticks, up
  to 30 ms, at 60-600 units each (Node: ~0.1 ms): starved threads, not dense
  blocks. kp:89 44 / 72 / 131 ms, tail 18 ms p95, tick p95 417 ms.
- Edge headed (how it is played), same scene: kp:89 36 / 42 / 55 ms, tail
  3.3 ms p95, longest job 11 ms, tick p50 145 / p95 211 ms over the first
  window; settled (from tick ~120) tick p50 ~128, p95 ~150, max ~170 ms:
  no spike stands out. Ticks 40-120 after the restore are slower (movement,
  the worker search tier, unit events: the battle starting). With 7 helpers
  cpu:89 is only 8% lower (353 -> 327 ms): Edge's jobs are ~1.5x Node's,
  not from core contention. The kernel runs ~10.5 threads busy: smaller
  blocks or another schedule would not shorten it; less work per job would.
- Headed Edge, settled tick 131 ms mean: simMoveRun 62 (kp:89 34, kp:8 11,
  traffic 2, block counts 2), worker search tier 14, combat scan 8, relayout
  7, background waits 7, spawner queue 7, _wsCommit 6, unit events 6.
- Kernel 89's CPU by part (Node helpers, a named build with --features=prof;
  move_job's inlined parts now split out under prof): checked_traffic_q
  17% self (56% with what it calls), move_job 11%, leader_dir 6.4%,
  resolve_slot 5.9%, motion 5.4%, traffic_swap 5.2%, cache_chunks 4.9%,
  epi_slot 4.7%, traffic_yield 4.1%, free_r3 4.0%. The per-job setup
  (leader_dir, cache_chunks, row_live: O(block area), whatever the units)
  is ~12% of the kernel.
- One 255 ms tick (headed): kernel 151 (FLOW_PENDING) waited 80 ms for its
  end while its chunks took ~1 ms: the simulation thread was in a
  background chunk it took while waiting (_simBgHelp). Not seen again in a
  280-tick run (longest help chunk 10 ms, lane 3 kernel 31); traced now.
- tests/sim-frame-replica: the test started the match before its worker had
  loaded, so the page made the match (and the page has no kernels: no slot
  allocator since the JS one went). It now waits for the worker: pass.
  A real start is unaffected (the page skips the starters when the worker
  takes the match).
- Determinism suites (deterministic-sort, lockstep-hash-stream,
  event-route, shared-spatial, tower-simd, chaos-scenario,
  multiplayer-chaos, and multiplayer-chaos with SIM_WORKER=1 and 4 host
  helpers): all pass.
- Next: the per-job setup (leader_dir / cache_chunks once per block row or
  from the index, not per job over the whole block), then checked_traffic_q.

### 2026-11-09 — keep unrelated background chunks off the caller's wait path

- Target: the recorded headed Edge tick 89, 254.5 ms, whose FLOW_PENDING
  tail was 80.4 ms (kernel 82.7 ms). Neighboring ticks 88/90 took 155.0 /
  161.0 ms; nearby tick 87's FLOW_PENDING tail was 3.9 ms. Occupancy stayed
  around 34–39 ms. These idle-scene ticks have no player-action burst.
  `simParallelRun` excluded only movement from `_simBgHelp`; other kernels
  and `simParallelBackgroundWait` could claim an unrelated, non-preemptible
  chunk after exhausting their own work. Its duration then extended the wait.
- Removed that cross-lane help from both waits. The simulation thread still
  claims all available work for the dependency it actually needs. Helpers
  keep running other lanes, and the caller joins each at its own wait.
  No work is dropped, deferred by a tick budget, or capped. This changes the
  existing JS worker orchestration only; simulation kernels remain WASM,
  with no new JS per-item processing or fallback and no binary rebuild.
- `tests/foreground-wait.test.cjs` uses a real helper and a handshake to
  leave the final required chunk running while another lane has an 80 ms
  chunk available. It asserts which thread claimed the unrelated work,
  rather than imposing a flaky elapsed-time threshold, and verifies that
  the unrelated chunk still completes exactly once. Both foreground and
  background-lane waits are covered. Both old paths fail (90.5/92.2 ms;
  unrelated chunk claimed); both changed paths pass (44.5/45.7 ms;
  unrelated chunk not claimed). The elapsed values are diagnostic only.
  Before/after test logs are retained alongside the measurements.
- Raw measurements and the pre-change scheduler are retained under
  `tests/test-runs/foreground-wait-20261109/`. Large mixed chaos first:
  1,000,004 initial units, 65,536 structures, dk=1, 11 helpers, recurring
  input bursts every 10 ticks. Serial unprofiled runs in A/B/B/A order,
  240 ticks each, settled window 60–239 (180 samples/run):

  | Run | Wall p50 | p95 | p99 | max | >100 ms | >150 ms |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | Before 1 | 75.3 | 91.0 | 102.8 | 125.6 | 3 | 0 |
  | After 1 | 72.6 | 92.0 | 95.8 | 95.9 | 0 | 0 |
  | After 2 | 74.4 | 95.6 | 109.8 | 115.4 | 6 | 0 |
  | Before 2 | 74.0 | 88.3 | 99.1 | 103.0 | 1 | 0 |

  Pooled before/after mean 74.96/74.60, p95 89.37/92.79, p99
  102.41/101.21, max 125.59/115.43 ms. **No consistent general tail-latency
  improvement established**: >100 ms counts were 4/360 before and 6/360
  after; before 1's worst tick included 11.3 ms GC. The guarantee is removal
  of the particular unrelated-chunk wait extension, not elimination of GC
  or scheduling stalls. Early gameplay is retained in every raw file;
  all-gameplay maxima were 2,161/2,115/2,005/1,428 ms in run order, separate
  from settled timing and from loading/setup.
- Every run measured the same settled population, 255,480–382,370, with
  13,650 births and 141,074 deaths. Useful-work counts also matched exactly:
  4,985 research deposits, 1,688 collector and 1,368 astar deposits, 855
  construction completions, 1,703 healer deliveries and 86 salvage returns.
  Before 1 / after 1 / after 2 throughput per wall second: research
  367.6/375.1/367.5, collector 124.5/127.0/124.4, astar 100.9/102.9/100.8,
  construction 63.0/64.3/63.0. Required background waits averaged
  3.25/3.26/3.31 ms per tick, so the first comparisons show no material
  transfer of cost to those waits. Full per-run throughput is in summary.json.
- Separate baseline profile: `before-profile.json` plus the simulation
  and all 11 helper CPU profiles, analyzed with `chaos-spike-profile.cjs`.
  Previous/slow/next/reference steps 63/64/65/68: 88.5/108.0/89.5/85.1 ms;
  all non-burst ticks. Movement grew 37.1→46.5 ms, slot movement
  5.9→9.9 ms, worker search 6.4→10.2 ms. Main-thread GC overlap was zero;
  helper samples included GC and background navigation/free work. This
  capture did not reproduce the rare 80 ms caller stall. All per-thread
  neighboring-tick attribution is retained in the spike-analysis sidecar.
- The Edge occupancy probe now reads population from the simulation worker;
  the page's `units.length` incorrectly reported zero in worker mode.
- Headed Edge, the restored chaos-1m-250k scene, 60 s captures, no input
  bursts: compare the common settled ticks 120–239. Before/after p50
  163.6/134.3, p95 206.2/158.8, p99 230.9/169.2, max 269.6/179.6 ms;
  >200 ms 10/120 versus 0/120. No page errors. The after run ends with
  214,636 actual units; the before run's old page-side population counter
  was invalid, so it cannot establish equal browser populations. This is
  one browser pair with broad phase differences, not proof that the whole
  gain came from removing caller help. The serial Node A/B/B/A remains the
  controlled throughput comparison.
  Previous/slow/next/reference browser rows are saved separately: before
  ticks 132/133/134/130 took 193.0/269.6/201.1/169.8 ms (spawner queue
  7.3/72.8/9.1/9.8 ms); after ticks 193/194/195/189 took
  125.5/179.6/158.8/133.5 ms. The latter slow tick has extra movement,
  effective-stat and visibility work, not a FLOW_PENDING tail. Full early
  captures are retained too (maximum 675.3/413.0 ms); the before early
  outlier included 154.6 ms frame encoding and multiple inflated phases.
- Remaining: the reproducible caller priority inversion is removed, but
  movement's occupancy/collision work remains the largest regular cost.
  A future spike investigation should profile the occasional spawner queue
  and frame-encoding outliers, separating GC/OS delays from kernel work;
  these measurements do not establish their cause or claim to fix them.
- Validation: all 12 serial suites passed: foreground-wait,
  background-chain, background-failure, nav-background, parallel-kernels,
  deterministic-sort, lockstep-hash-stream, event-route-determinism,
  shared-spatial-determinism, tower-simd-determinism,
  chaos-scenario-determinism and multiplayer-chaos-determinism. Logs:
  `tests/test-runs/run-all/2026-11-08T22-45-23-033Z/` (UTC directory name).
  The scheduler tests cover 0/1/7 helpers, including errors, lane reuse,
  stage ordering and exactly-once work. `git diff --check` passed.
  The additional `SIM_WORKER=1 CHAOS_HOST_HELPERS=4` multiplayer chaos run
  also passed: 2,598 tick hashes matched per map across all six maps,
  including forced-divergence resyncs and host slot relayout. Its log is
  `tests/test-runs/foreground-wait-20261109/worker-chaos-h4.log`.

### 2026-11-09 — wake helpers when late bindings make pending work runnable

- Priority remains gameplay stalls, not the regular occupancy cost. No
  occupancy or other WASM kernels were changed in this session. Raw traces,
  all helper profiles, source snapshots and comparison scripts are under
  `tests/test-runs/occupancy-20261109/` (the directory was named before the
  investigation narrowed to the scheduler).
- Found a lost wake in `simParallelHelperMain`: a helper can observe a job
  before its binding messages, yield to receive messages, then sleep on the
  already-observed foreground generation. Later `bind`/`binds` messages
  updated its registry but did not wake its scheduling loop. A pending
  background job then depended on another job being posted or the caller
  executing it at its wait. This can happen during play after a rebind,
  not just on the first tick.
- Binding arrivals now notify the wait and set a local flag. The flag also
  covers bindings delivered during `nextTask`, before a wait is armed.
  The foreground generation is not changed; work ownership, phase barriers,
  priorities and exactly-once claims are unchanged. This is JS thread/message
  orchestration, not per-entity simulation logic or a JS kernel fallback.
- `tests/background-bind-wake.test.cjs` deterministically withholds bindings
  until a real helper has observed the pending job and armed its wait. It
  then delivers the bindings without posting another job or allowing the
  caller to claim work. The saved old scheduler times out; the fixed one
  completes exactly once, for both single and batched bindings, without
  changing the foreground generation. The deadline is a deadlock guard,
  not a performance threshold.
- Loading: `workerBrainReserve` now allocates and binds the map-sized
  sites/count/owner scratch alongside the event list, before the existing
  setup memory prefault. `simMatchPrepare` also builds the completed world's
  spatial index. These remove first-use allocation/binding/index setup from
  gameplay. Preparation still advances no tick, consumes no queued order,
  and leaves the exact gameplay state hash unchanged; the expanded
  `match-prepare` test checks that and the prepared buffers/index.
  **This does not move the entire first simulation step into loading.**
  Initial combat, movement and newly submitted commands still execute as
  gameplay. Their remaining cost must not be called loading or omitted.
- Attribution: the initial mixed settled capture's worst step 89 was
  119.3 ms, reference 85 was 93.7 ms, with movement 67.5 versus 54.3 ms
  and no main-isolate GC overlap. The neighboring ticks and all twelve
  threads are in `before-profile.json.spike-analysis.json`. A separate
  early capture found step 0 at 2,562.5 ms: 1,193.6 sampled ms in
  `k_worker_spawners` on the caller while helpers spent much of the tick
  idle. This is consistent with the binding starvation mechanism, but
  does not establish that all of the first-tick excess had that cause.
  Step 0 has no previous gameplay tick; next step 1 and same-burst-status
  reference 10 are retained in the early analysis.
- Settled whole-selection command capture, with worker presentation/post
  enabled: previous/slow/next/reference steps 79/80/81/70 were
  92.5/128.2/94.8/112.2 ms. Slow and reference both have recurring action
  bursts; step 80 additionally commands the whole selection. Its
  `runQueuedOrders` took 25.9 ms, including 16.1 ms in the serial WASM
  `k_order_workers`. The after diagnostic's corresponding steps were
  100.3/133.3/110.3/113.5 ms. Both neighboring-tick analyses include all
  helpers; these profiles do not demonstrate a command-spike improvement.
- Acceptance measurements ran serially, unprofiled, A/B/B/A: large mixed
  chaos, 1,000,004 initial units, 65,536 structures, 11 helpers, dk=1,
  180 steps, measured steps 60–179. Recurring input bursts every ten steps,
  plus whole-selection clicks at 80/82/84; `--worker-post --no-census`.

  | Run | Wall p50 | p95 | p99 | max | >100 ms | >150 ms |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | Before 1 | 77.9 | 99.6 | 106.0 | 119.1 | 5 | 0 |
  | After 1 | 77.1 | 99.4 | 116.4 | 122.7 | 5 | 0 |
  | After 2 | 77.4 | 99.6 | 113.1 | 118.5 | 5 | 0 |
  | Before 2 | 79.5 | 108.2 | 116.4 | 120.2 | 13 | 0 |

  Pooled before/after: mean 80.26/78.81, p95 104.75/99.43,
  p99 116.43/116.41, max 120.23/122.72 ms; >100 ms 18/240 versus
  10/240. **No consistent reduction in worst-tick latency established.**
  The last baseline is slower broadly; the first pair is essentially
  unchanged and the pooled maximum is slightly worse. The robust result
  is removal of the tested lost wake, not uniformly stable TPS.
- Every acceptance run had identical measured population and work:
  288,743–382,370 units, 2,433 births, 96,594 deaths, 2,522 research
  deposits, 165 collector deposits, 953 astar deposits, 423 construction
  completions, 1,468 healer deliveries and 29 salvage returns. The first
  whole-selection command affected 148,862 units and 10,808 buildings;
  no queued units, backlog IDs or unapplied rallies remained afterward.
  Before 1 / after 1 / after 2 / before 2 research throughput was
  266.77/266.62/266.73/257.09 deposits per wall second, construction
  44.74/44.72/44.74/43.12 completions/s. Full throughput is in
  `summary.json`; average required background waits were
  2.59/2.75/2.76/2.72 ms per step.
- All first gameplay ticks are retained: 1,553.6/1,509.6/1,432.7/1,584.9
  ms in run order. Separate world-dependent loading preparation was
  187.9/204.1/194.0/188.2 ms (other loading/reservations precede that
  timer). The large initial gameplay spike is **not eliminated**.
- Validation: 15/15 serial suites passed, including late-binding wake,
  foreground-wait, background-chain/failure, navigation background,
  parallel kernels, sorting, lockstep hashes, event routing, spatial and
  tower determinism, chaos, multiplayer chaos, worker spawner decisions,
  and loading preparation. Logs:
  `tests/test-runs/run-all/2026-11-09T09-06-19-238Z/`.
  A separate four-helper spawner test passed 6,400 exact nearest-site
  checks. `SIM_WORKER=1 CHAOS_HOST_HELPERS=4` multiplayer chaos also passed:
  2,598 matching tick hashes per map on all six maps, with forced-divergence
  resyncs and host relayout. Its log is `worker-chaos-h4.log` beside the
  measurements. Syntax checks passed; Git's whitespace check passed with
  `core.whitespace=cr-at-eol` for main.js's existing tracked CRLF format.
  Old/fixed wake regression logs are `bind-wake-before.log` and
  `bind-wake-after.log`. No WASM rebuild was needed.
- Remaining priorities: the measured whole-selection order burst (serial
  worker task/reservation cleanup), further first-use work that can safely
  finish before multiplayer readiness, and browser spawner/frame-encoding
  outliers from the previous session. No new headed-browser timing claim
  is made here. Gameplay stalls and uniform multiplayer tick durations
  remain unresolved beyond the two specific scheduler mechanisms fixed.

## 2026-11-09 — loading caches, native pending-path cleanup, response measurements

- `simMatchPrepare` now builds movement structure/block tables, worker search
  grids, laser link maps and missing navigation profiles before readiness.
  It uses the existing WASM kernels and heap tables. Repeated preparation
  reuses valid caches; the regression checks that time, tick, queued input,
  unit collection phase and authoritative state hash do not change. This
  moves real reusable world data, not a simulated/discarded gameplay tick.
- Worker move-order pending-path cleanup and digest repair now run wholly
  inside `k_order_workers`. Removed the per-worker JS repair loop and its
  selection-sized output buffer. The regression covers pending-target and
  fallback-flag encodings, checks field/digest agreement, and rejects calls
  back into `simPendingClear`. Both WASM32 and WASM64 were rebuilt. This is
  one removed JS pass, **not** completion of the O(1) command pipeline:
  reservation/path release is still serial and exceptional order cases
  still reach the pre-existing JS movement fallback.
- Rejected experiment: running the worker spawner query during preparation
  produced scratch answers that gameplay discarded. It did not establish
  a first-tick improvement and was reverted, including both binaries.
  `loading-profile.json` records that rejected experiment; do not confuse
  it with the final `followup-profile.json`.
- Raw artifacts, source baselines, CPU profiles for main plus all 11 helpers,
  logs and reproducible comparison/summary scripts are in
  `tests/test-runs/loading-orders-20261109/`. A/B/B/A measurements ran
  serially, with 1,000,004 initial units, 65,536 structures, 1024-square
  map, dk=1, worker presentation enabled, no periodic census, 180 steps,
  and whole-selection orders at steps 80/82/84. Window: steps 60–179.

  | Run | Loading prepare ms | First tick wall ms | p95 | p99 | max | >100 / >150 ms |
  | --- | ---: | ---: | ---: | ---: | ---: | ---: |
  | Before 1 | 184.1 | 1506.8 | 107.7 | 132.2 | 190.9 | 9 / 1 |
  | After 1 | 216.7 | 1184.9 | 97.2 | 116.4 | 125.4 | 5 / 0 |
  | After 2 | 231.3 | 1099.6 | 111.4 | 146.1 | 153.3 | 11 / 1 |
  | Before 2 | 191.5 | 1544.5 | 122.5 | 222.0 | 244.4 | 14 / 3 |

  Pooled p95/p99/max: 111.6/200.1/244.4 → 104.5/142.1/153.3 ms.
  **Not a controlled general gameplay latency improvement claim:** loading
  navigation earlier changes the synthetic scene's subsequent evolution.
  Before population was 288,743–382,370; after 288,281–382,309. Repeats
  within each version have identical population/work counts. Before/after
  births were 2,433/2,454; deaths 96,594/97,029; research deposits
  2,522/2,921; construction completions 423/433. Research throughput in
  run order was 254.35/302.36/300.36/244.07 deposits/s; construction
  42.66/44.82/44.53/40.94 completions/s. Full work/throughput and raw ticks
  are retained in `summary.json` and each run. Preparation timing excludes
  earlier match setup, so it is not total loading time.
- Added `--mass-followup-units=1000` diagnostic: whole-selection order then
  one new destination for a subset, with no building orders in the follow-up.
  `response` reports target application, changed positions, deaths and wall
  time since simulation receipt. These are end-of-tick upper bounds,
  excluding UI/network/render latency; diagnostic scans are outside timing.
  A changed position after target application is not proof that every unit
  has an unobstructed route. The option and caveats are documented in
  `tests/CHAOS_SPIKES_BENCHMARK.md`. Also initialized timeline intervals
  before worker presentation setup can invoke an instrumented kernel.
- Final diagnostic (`followup-profile.json`): step 20 ordered 236,678 units
  and 11,735 buildings with 512,156 units alive at tick end. All queue,
  backlog and rally counts drained that tick, but wall time was 173.9 ms.
  Step 21 retargeted 1,000 units with 506,822 alive. By the first end-of-tick
  observation (133.7 ms after receipt), all 988 surviving selected units
  had the requested target, 897 had changed position, and 12 had died.
  At the next observation (259.7 ms), 923 surviving selected units had
  moved. This is a responsiveness baseline, not evidence that priority or
  starvation protection has been implemented.
- Neighbor/profile slicing compared step 19 (143.4 ms), slow step 20
  (173.9), next step 21 (130.2), and normal recurring-burst step 30
  (129.3). The reference has ordinary recurring actions, not an identical
  mass selection. Queued-order cost was 0.006/25.42/8.32/2.71 ms;
  movement 60.74/71.06/74.05/54.83 ms. The large order's worker kernel
  alone took 17.56 ms. There was no main-isolate GC on steps 19–21;
  reference GC was 8.01 ms. Helper slices show navigation field and atlas
  route work expanding on the large command. The next tick's main profile
  still samples `_makeFallbackPathForUnit` (6.12 ms sampled self time),
  whereas its native worker order work is only 0.108 ms. Therefore merely
  moving the native worker loop would not solve every command spike.
- Remaining startup spike: final profiled first tick is 1,121.8 ms, including
  358.4 ms unit events, 326.4 ms movement, 125.7 ms tick-chain wait and
  92.9 ms visibility (inclusive phases overlap). Initial movement structure,
  worker-grid and laser-link builds no longer appear in that tick.
  A full readiness barrier still needs useful initial decision preparation,
  not warmup whose outputs are thrown away. Gameplay command admission,
  exceptional paths, shared reservation release and background route
  throughput remain priorities. No arbitrary production work caps or
  new JS fallback were added. No new headed-browser result is claimed.
- Validation: 16/16 serial suites passed, covering loading preparation,
  queued hashes, worker orders, fast/multi-point orders, scene orders,
  worker walking/work and completion publication, laser updates, navigation,
  parallel kernels, foreground waits, binding wakes, chaos and multiplayer
  determinism. Logs: `tests/test-runs/run-all/2026-11-09T14-28-45-965Z/`.
  The new worker regression fails on the pre-change source/binary and passes
  on both current WASM32 and WASM64; loading preparation also passes on
  WASM64. Separate logs are beside the measurements. JavaScript syntax and
  Git whitespace checks passed (existing main.js CRLF respected).
  `SIM_WORKER=1 CHAOS_HOST_HELPERS=4` multiplayer chaos also passed; its
  full peer-hash/resync results are in `worker-chaos-h4.log`. Nothing committed.

## 2026-11-09 — automatic lockstep initialization behind loading

- Replaced the four-tick overlay cutoff with an actual completion barrier.
  The host seals only one initialization tick at a time and waits for every
  active player's completed tick, not their pre-sent input packets. Worker
  autonomous ticking/presealing stays disabled during initialization.
- Initialization runs real dk=1 simulation and retains all results. Player
  input remains blocked behind the loading screen. A shared release boundary
  enables normal gameplay, worker pipelining and adaptive delta ticks.
- Automatic completion uses two adjacent four-sample work-cost windows:
  recent mean within 0.8–1.25 of the preceding mean, recent maximum at most
  1.5 times its mean (1 ms noise floor). Eight samples is the observation
  window, NOT a fixed initialization length or a work budget. If startup
  costs are still changing, more lockstep ticks run behind loading. There is
  no target TPS, wall-clock cadence condition, timeout release or delta-tick
  shortcut. Every peer must satisfy the rule at the same completed tick.
- The host's release is session-scoped and retried in response to completion
  reports. Initialization timings are cleared before gameplay's adaptive
  controller starts. A guest's tick arriving before ALL_READY is recorded;
  live joins/reloads use the existing running-match recovery path rather
  than starting another global initialization barrier. Protocol revision 57
  prevents mixing clients that do not implement the new start protocol.
- This change is O(1) tick-level network/loading orchestration, not simulation
  item processing. It adds no JS simulation kernel or per-item fallback.
- Added `tests/init-loading-report.cjs`: applies the production readiness rule
  to retained chaos traces and reports the automatically selected boundary,
  first subsequent tick versus mean, p95/p99/max, slow counts, population,
  births/deaths and measured worker throughput. Run, for example:
  `node tests/init-loading-report.cjs tests/test-runs/init-lockstep/large.json`.
  This is trace replay, not a headed-browser measurement or a claim that
  later gameplay spikes have been optimized away.
- First serial large mixed run: 1,000,004 starting units, 65,536 structures,
  1024 map, 11 helpers, dk=1, worker publication, no census, 80 ticks. The
  automatic boundary is step 12: first exposed tick 113.14 ms versus the
  remaining mean 114.76 ms (0.986x). Original first tick: 1,371.25 ms.
  Post-boundary p95/p99/max: 154.93/197.06/197.06 ms; 5 ticks >150 ms,
  2 >1.5x mean. Actual measured population 353,447–581,539, 4,011 births,
  237,101 deaths; research deposits 151.65/s, construction completions
  74.61/s. Raw tick timings, phases and all throughput counts are retained
  in `tests/test-runs/init-lockstep/large.json` and its JSONL sidecar;
  boundary statistics are in `summary.json`.
- Remaining: a readiness detector cannot predict unrelated later command,
  GC, scheduling or periodic-work spikes. Serial reservation cleanup,
  exceptional simulation JS paths and background navigation remain separate
  gameplay optimization work. Startup simulation advances game time and
  combat/economy as normal; it is not discarded or reset on release.
- Repeat (2026-11-10, serial, 160 ticks, same large mixed setup):
  `tests/test-runs/init-lockstep/large-repeat-claude-160.json`. Automatic
  boundary step 11; first gameplay tick 117.4 ms vs next-20-tick mean
  121.2 ms (0.97x); whole-run post-boundary mean 95.8 ms (population falls
  586k -> 292k, so the whole-run mean understates boundary-time cost;
  `init-loading-report.cjs` now also reports `firstToNext20`). Post-boundary
  p95/p99/max 128.8/143.9/158.8 ms, 1 tick >150 ms. Behind loading: step 0
  1173 ms, steps 1-3 302/441/298 ms. The first 80-tick run gives 0.84x vs
  its next 20 ticks. Note: another session wrote `large-repeat.json` during
  an earlier repeat, so that file and its overlapping timings are not used.

## 2026-11-10 � initialization boundary confirmed; the acquisition chain misses its commit

- Repeat of the large mixed chaos run (1M start, 65,536 structures, 11
  helpers, dk=1, worker publication, no census, 80 ticks): the automatic
  initialization boundary is again step 12 in both runs. First gameplay
  tick vs post-boundary mean: 113.1/114.8 (0.99), 135.3/117.7 (1.15), and
  after this session's kernel edits 106.1/108.8 ms (0.98). The 1.15 case is
  population, not leftover startup work: the battle falls 581k -> 368k
  units over the run, and tick 12 matches its neighbours (131/135/153 ms).
  Reload/rematch (multiplayer-stale-loading, page + worker), jitter start,
  init stability, start wait and delta-tick suites all pass.
- Remaining gameplay ticks over 150 ms (5-9 of 68) sit in the early battle
  (ticks 13-30, ~150k deaths). New diagnostics in chaos-spikes.bench.cjs:
  `--occ-jobs` (per occupancy phase: wall, job count, summed job time,
  heaviest job and its units, via par.ctrace; and every background wait
  >1 ms with its lane, chain, running stage and done/total chunks), and
  `ACQ_EAGER=1` (diagnostic only, changes the schedule: the acquisition
  chain waited for right after its post, per-stage helper walls; with
  ROWX re-running each stage serially gives its CPU).
- Occupancy (kernel 89) is not the cause here: each phase ~7-9 ms, near
  work / threads. Ticks 20-23 showed 7-10 ms jobs of only 100-450 units on
  several threads at once: stalls, not dense blocks.
- Cause of the periodic +10-26 ms: combatScanRun's acquisition commit
  (phase 0, `wait:2`) finds the chain's scan stage (kernel 33,
  k_acq_sample area answers, 4,130 chunks) only 55-70% done on some
  commits (ticks 16, 28, 36) and finishes it on the tick.
- The chain's serial CPU per round (A = 126,461 areas, 2 teams): scan
  124-160 ms at 500-600k units (243 ms at 970k: ~250 ns per live unit,
  memory-bound, chunk overhead negligible), area count 19-38 ms (24 jobs,
  each zeroing a 1 MB histogram), answers 19-26 ms (10 jobs, up to 6.5 ms
  each), prefix 6-14 ms (one job, 24 x 253k keys), scatter 5-12 ms.
  Eager walls with 11 helpers: 37-86 ms the chain.
- Kept (output-identical; the run's population matches the earlier runs
  exactly): k_acq_area_prefix range-major (sequential rows; serial time
  unchanged within noise, ~6 ms); area_answer skips the four structure
  classes' reads for units that do not take a structure (attacking, not
  drive-by): no measurable scan change (243 vs 260 ms at 970k).
- Rejected: posting the chain at phase 1 (three ticks to the commit). Lane-2
  waits fell to one 5 ms, but the free lane (15, kernel 185 in
  spatialIndexRebuild, 29-33 ms) and the worker search lane (17 ms) started
  missing instead, and the 80-tick mean rose 115-118 -> 138 ms (p95 290 ms;
  simMoveRun 55 -> 67 ms, unitEventsRun 4.8 -> 7.3 ms). The helpers are
  close to saturated: moving one lane's deadline moves the miss.
- Next: cut the scan's per-unit memory traffic (one record per
  (team, area) for the nearest/distance and the four class answers instead
  of ten arrays; ids packed in the area buckets so the winner needs no
  slot -> id gather), and the count stage's 24 MB of histograms (fewer
  ranges or a sparse key space). Then a deadline-aware background order
  (a lane due at the next commit before one due later), measured with the
  same 80-tick run and the --occ-jobs waits.
- Raw data: tests/test-runs/init-lockstep/{large,large-repeat,large-post1,
  large-final}.json(+.jsonl), early-occ*.json, early-acq-eager*.json,
  acq-serial*.json; boundary summary in summary.json.

## 2026-11-10 (later) � the acquisition scan's memory layout

- Measured by parts (a temporary P[60] knob in k_acq_sample, removed; the
  scan stage re-run serially after an eager chain, ~510k live units, 475k
  eligible, nearly all idle / attack-moving, ~700 attacking): slot loop and
  filter ~11 ms, area answers over 1-4 tiles ~56 ms (ten arrays read per
  tile: nearest, distance and four classes' structure and distance), bucket
  sample ~40 ms, the winner's slot -> id gather ~15 ms; ~123 ms in all.
- Area answers packed: acq.saRec, one 32-byte record per (team, area):
  nearest area, the four classes' structure tiles, the five distances as u16
  (0xFFFF none; a distance is at most the answers' depth, the farthest
  reach, so the encoding is exact). New stage k_acq_area_pack (kernel 190,
  8192 records a job, ~3 ms CPU at 126k areas x 2 teams) after the answers;
  the answers' ten arrays stay their working storage (towers still read them).
- Bucket entries: acq.saE, one 16-byte record (x, y as f32 bits, slot, id)
  replaces acq.saX / saY / saSlot for every reader and writer (the serial
  build, the ranged scatter, area_answer, the opt-in sampled path,
  k_tower_acq). The four-wide SIMD compares became lane-by-lane scalar ones:
  the same IEEE sums, and b2 only falls, so the order and results match.
- Area build: 8 entry ranges (was 24). Each range's histogram covers every
  key (~253k at a 1024 map): 24 MB -> 8 MB to zero; the serial prefix
  6 -> 2.9 ms. The scatter keeps entry order for any range count.
- Exact: the 80-tick large mixed run's per-tick unit counts and every work
  counter equal the previous build's at all 80 ticks (twice). Tower suites
  (batch, SIMD determinism 0 vs 3 helpers, kernel cases, structures only,
  due table), first-tick loading, jitter start (workers) and delta-tick
  multiplayer pass.
- Serial scan CPU: 506k units 123 -> 100-104 ms, 970k 243 -> 206-212 ms
  (-13-17%, two runs). 80-tick run: mean 105.4 / 113.1 ms and p95 131 / 169
  ms across two runs, against 108.8-117.7 / 155-168 before: inside this
  machine's noise today (15-62% CPU load from other programs with no bench
  running), so no tick-time claim. The early-window commit waits remain
  (14.7, 24.6, 16.4, 8.3 ms; at step 35 the scan had 368 of 4,126 chunks
  done): the chain is still starved before its scan, not only slow in it.
- Seen twice at step 19 in bit-identical runs: researchDrainTick 32-38 ms
  against 3.6-5.4 ms in others (same state): a stall (GC / JIT) landing
  there, not research work. Open.
- Next: the chain's remaining cost, ~100 ms scan + ~20 count + ~18 answers
  per round at 500k (scan ~200 ns a live unit: the bucket sample's random
  line and the tile records), and the background order (lane 2 behind lanes
  0, 10, 6, 13) - measure on a quiet machine before any schedule change.

## 2026-11-10 (night) � rendered runs: pace bug, helper oversubscription, post-load GC

All measured in headed Edge on the real page (simulation worker, helpers,
presentation worker, WebGL rendering): `.claude/scene_tps_probe.cjs
scenes/chaos-1m-250k.gz 90` with HEADED=1, QUERY=simtrace=1,
DUMP=tests/perf-fuzz/simtrace-dump.js; analysed with
`node tests/simtrace-spikes.cjs <out.txt>` (step totals, chunk stalls, fps,
each slow step against its neighbours) and, with TRACE=<file>
TRACE_CATS=devtools.timeline,blink.user_timing,disabled-by-default-v8.gc,
`node tests/trace-gc-steps.cjs <trace> <out.txt>` (the worker's MinorGC /
MajorGC per step: the worker marks each traced step, 'simstep <tick>').
Raw outputs in tests/test-runs/rendered-20261110/.

- Bug (from the initialization barrier): a restored scene (restoreSoloGameSnapshot)
  re-armed the barrier in startGame and never released it, so
  matchInitializationActive() stayed true all game: dk pinned at 1 and the
  adaptive pace off. Now the barrier is active only once a match start began
  it (guests' early-bundle auto-start only in multiplayer), and a restore
  releases it as a running match. first-tick-loading has a never-started case.
- The worker's trace rows now carry dk (`tick` counts steps).
- Helpers oversubscribed the machine when rendering: simParallelInit's reserve
  (cores - 5) did not count the presentation worker's own helpers (3 here).
  Two runs each, 16 threads: 11 helpers had 54-57 steps with one chunk over
  10 ms (a helper descheduled inside its chunk: kernel 37 dead-marking 41 ms,
  131 55 ms, occupancy jobs of 60-120 units 6-20 ms), 29-31 steps over 1.5x
  the mean; 8 helpers 7-9 and 7-16; the same game ticks a second (18.9),
  33.0-34.8 against 34.3-37.6 ms a base tick, fps 84-103 against 78-90.
  10 helpers: 17 stalls, 30 slow; 6: 4 stalls, 31 slow (bigger dk swings).
  Default now max(ceil(cores/2)-1, min(cores - 5 - presentation helpers, 15)):
  8 here, unchanged at 32 threads. Node benches pass helpers explicitly.
- Remaining slow steps are V8 major GCs in the simulation worker (37-77 ms):
  trace-gc-steps attributed 103 of 192 ms and 130 of 234 ms of the slow
  steps' excess to them. The worker's JS heap is ~570-650 MB right after a
  scene load and ~245 MB in play: the first one or two major GCs after the
  load collect it. Earlier "unitHitsResolve +90 ms" and "researchDrainTick
  +32 ms" one-offs were these collections landing in that phase.
- Load garbage cut (tickbench SOLO SCENE HEAPPROF_LOAD, new HEAPPROF_MINOR=0
  (promoted only) and HEAPPROF_LIVE=1 (alive after a full GC); promoted
  minus live = old-generation garbage, ~261 MB before):
  * restore no longer generates a random map only to replace it
    (startGameSkipMap, page and worker): generateAreas, generateResourceMines
    Mixed, settleSpawns, their area caches (~215 MB promoted garbage);
  * applySoloScene's rows(): one array a record kind, not a generator (an
    iterator result a row in every pass, ~40 MB);
  * rebuildAreaDistanceCachesFromAreas (every match start, joins): typed
    adjacency pairs counted by area, deduplicated by stamp, sorted, instead
    of a Set per area (126k Sets, ~25 MB): tests/area-neighbors.test.cjs
    checks it against the Set version on 40 random maps.
  Promoted garbage over the in-page load ~261 -> ~50-96 MB (sampling noise).
  In the worker the post-load heap is still ~570-610 MB: the scene arrives
  as a structured-cloned message (its rows are JS arrays), restore-only.
- Steady play: one major GC of 53 ms at a ~250 MB worker heap in one run, 13
  ms in another: the live JS heap (the tile grid's cell objects, areas' cell
  lists of {x, y}, unit objects) sets that pause in every match.
- Next, by size: the tile grid (initGrid: 1M cell objects, ~50 MB live) and
  area cell lists into typed columns in the wasm heap; the scene sent as
  binary columns (restore); simUnitStateCollect's whole-world pass over the
  units proxy at a new units epoch (~18 MB of iterator garbage) by the row
  index's slots once that equivalence is proven.

## 2026-11-11 — map cells and areas in the wasm heap, scenes as typed columns, rendered runs

All rendered numbers: headed Edge, `.claude/scene_tps_probe.cjs
scenes/chaos-1m-250k.gz 90` with simtrace + GC trace, 8 helpers; raw data in
tests/test-runs/map-wasm-20261111/ (before*, after*, cols*, cols2*, cols3*).

- The tile grid holds numeric handles (one-based tile index) in a heap
  Int32Array; rows are views of it. cellType / cellOwner / cellArea are the
  only cell state; items come from the structure table (cellItemGet). Area
  generation (k_map_generate) and topology (k_map_topology, world_map.rs)
  run in wasm; the page uses a small map-only heap with the same exports.
  Area cells are tile indices (views of one tiles array). Same map, area
  neighbour order, cell order and RNG state as before (checked on 192 arena
  and 200 random maps against the last commit).
- Scenes: soloSceneReader packs rows into typed columns as it reads (units,
  buildings, mines: Float64 rows; terrain runs, area tiles: Int32; type names
  in small tables; rare building extras sparse). No records are kept; the
  worker gets the columns as transferred buffers (sim_client.js). Before,
  the scene was a structured clone of millions of small arrays held until
  the restore ended.
- spatialUnitsByArea (126k empty arrays a match start) removed: its only
  reader tested for a Set and never ran.
- Fixed: a shadowed `cellOwner` local in the hostile-structure table
  (data_state.js, TDZ error whenever a tile held the entity); cellColumnsRehome
  (a page taking over from a failed worker) now also rebuilds the area tables
  and their views in the new heap (they stayed in the map heap: kernels
  refused them, sim-worker-failure); it only runs with a simulation heap.
- Tests: many fixtures and helpers still read cells as objects or area cells
  as {x, y} and silently got undefined (chaos-spikes-scenario's area
  upgraders were never placed, so the flow test's scenario changed; the
  adjacency oracle; crowd-traffic's wall). All converted; flow-looks-commit
  gives exactly the last commit's numbers again. New failures from the
  conversion: all fixed. 16 tests also fail at the last commit (aff84ec):
  action-budget, deltatick-fairness, heap-grow-ahead,
  history-structure-columns, mixed-rally-move, multiplayer-desync-recovery,
  multiplayer-input-overflow, multiplayer-recovery-authority / -late /
  -order, multiplayer-reload-input, multiplayer-scenarios, shared-unit-state,
  unit-hidden-class, unit-id-index, visibility-range-collision: open.
- Worker heap (trace MajorGC events), previous session's run vs three runs now:
  first major GC after load 44 ms at 657 MB -> 33-54 ms at 323-431 MB; the
  compaction after it 95 ms -> 39-43 ms; live heap ~162 -> ~160 MB; steady
  play major GC 11 -> 13-14 ms.
- Steps (ms, p50 / p95 / p99 / max, steps > 1.5x mean): previous 123 / 213 /
  276 / 321, 26; now 146 / 251 / 382 / 467, 24 (one bad run), 130 / 195 /
  226 / 300, 17 and 126 / 197 / 259 / 310, 19. Base tick ~33-35 ms (same).
  Slow steps (simtrace-spikes): 2, 2 in the good runs; GC share of their
  excess 57 of 163 ms and 0 of 181 ms (was 88 of 88).
- Remaining: the occupancy kernel (89) is the largest cost (~355 ms of
  helper CPU a step, kp:89 ~44 ms wall) and its slow steps keep the same job
  count with ~50% more time per job, together with the other parallel
  kernels of that step (combat scan kp:20 correlates 0.57): every helper
  slower at once, not one stalled. tests/trace-thread-load.cjs (new) shows
  the traced threads (page, presentation worker, compositor) less busy in
  slow steps, so the contention is outside the trace (GPU process, OS, SMT
  siblings). Per-job cost also rises over a run (0.45 -> 0.72 ms) as fights
  concentrate into fewer blocks. Less work per occupancy job is the lever
  (checked_traffic_q 56% with callees, per-job O(block area) setup 12%:
  see 2026-11-08). Post-load garbage still 160-270 MB (unit objects at
  restore?), live heap 160 MB: a heap census next.

## 2026-11-11 (later) — every test passing; why slow steps are slow; reserved helpers measured

- The 16 tests that failed at the last commit, and render-frame-stability, all
  pass (281/281). Real fixes among them:
  * startSoloGame waited for nothing: started while the worker was still
    loading, the page made the match itself (it has no kernels: k_slab_take
    failed). It now waits for the worker's load (simClientWorkerLoading /
    simClientWhenLoaded).
  * Input was dropped whenever any loading overlay showed: a mid-match
    reload, resync or recovery threw away the player's commands.
    matchInitializationBlocksInput is now only the new match's
    initialization (its barrier begun, not released).
  * Builders stood forever at a site whose only free side held idle
    builders: a blocked mover never swaps with a worker (mvWk 1 for any
    worker state, IDLE too) nor with a unit of its own crowd. The move
    kernel now reads unit.wkS (word 36, W_WKS): idle workers give way, and a
    worker on its way passes idle workers of its crowd. traffic-pressure
    (strict speed) still passes; a first version exempting every flag-128
    mover from the crowd rule gave walkers 1.85x speed in the wall case.
  * Test-side: fixtures without unit handles, slot release that now returns
    slots two calls later, a threshold off by the heap's initial free space,
    a bench without the match's slot reservation, a browser test ordering
    units before the match's initialization ended.
- Slow steps (tests/slow-step-attribution.cjs, new: growth per phase over
  every slow step of several runs against its neighbours): over 71 slow
  steps of four runs, 1.7 s of excess, spread: simMoveRun +662 ms (kp:89
  only +194), background waits +368 (39 steps), worker search tier +247,
  combat scan +199, relayout +171, visibility +143, spawner queue +129. The
  biggest single ones: a navigation build's install (lane 1) waited 89 ms,
  the worker search commit (lane 4) 83 ms, retirement prep + relayout 70 ms.
- Background lanes (new trace fields bgAge / bgLeft at each wait, and the
  helpers' background chunk counts hbg / hbg4 / hskip4): helpers do run
  background work (~8,800 chunks a step, 1-2k of lane 4); the worker search
  (lane 4, WS_SCAN 39 / NEARFIELD 99 / ELIGIBLE 108 / RETURN_SPAWNERS 136)
  is still 2.5-3 of its 6 stages short at its commit a step after its post,
  and the simulation thread runs 18-25 ms of its scan then. Not a starved
  lane: more work than the helpers' spare time.
- Reserved background helpers (?simbgonly=N: helpers 0..N-1 take background
  lanes only, SIM_PAR_BG_ONLY), headed Edge, 1M chaos, 90 s runs:
  0 of 8 (4 runs): 30.6-33.4 ms a tick (32.0 mean), waits 5.7-6.6 ms a step,
  p95 178-209, p99 214-228, max 243-303, fps 86-99. 1 of 8 (3 runs):
  31.8-33.0 (32.4), waits 2.6-6.0, p95 186-219, p99 205-260, max 237-405,
  fps 75-85. 2 of 8: occupancy wall 46 -> 56 ms, bigger steps; 3 of 8
  similar; 10 helpers with 2 reserved: 36.6 ms a tick (oversubscribed).
  The waits shrink but the tick does not: on 16 threads every core is busy
  (simulation, its helpers, presentation and its helpers, page, GPU), so a
  reserved thread moves work and costs frames. Default stays 0; the knob
  stays for bigger machines. The lever is less work: occupancy, then the
  worker search scan.
- Tools: tests/compare-runs.cjs (runs side by side: ms a tick, step
  quantiles, slow steps and excess, waits, fps), tests/slow-step-attribution.cjs.
- Helper CPU by kernel (Node, chaos-1m-250k, 8 real helpers, a prof build
  --features=prof --keep-names; tests/test-runs/occ-prof-20261111/): of 21.3 s
  busy, occupancy (mv_move_occupancy) 23%, exact flow looks (mv_flow_exact,
  lane 13) 18%, movement (mv_move) 11%, then acquisition sample, status, slot
  move, nav fields, effective stats, free-slot zeroing, worker scan (each
  1.5-3%); the helpers' spin-wait 2%. By function it is flat: atlas_step 5%,
  seg_open 5%, flow_look_vals 4%, checked_traffic_q 4%, move_job 4%.
- Exact flow looks: the shared look cache (2^18 entries) hits 3.6% (dbgc
  counters 110-112 in mv_flow_exact; 250k chaos, no helpers): ~28k answers
  computed a step. tests/probes/flow-keys.js (chaos-spikes.bench.cjs
  --step-eval=@file, new) shows why: 30-50k pending keys a step, nearly all
  distinct (tile, destination) pairs, ~100 destinations, the build and wall
  versions merge none, almost none repeat from the step before. The work is
  unique per step: the lever is a cheaper answer (atlas stepping,
  flow_look_vals) or fewer units needing one, not the cache.
- The per-chunk clearing of the atlas step and exit caches (16 KB) in
  mv_flow_exact is ~1 us a chunk: not worth changing.

## 2026-11-11 (evening) — exact flow looks: why they were wasted, and what was kept

- Debug counters (dbgc 100-128 in mv_flow_exact / mv_flow_commit /
  look_keep; chaos-spikes.bench.cjs --dbgc, 250k, no helpers) showed the real
  waste: of ~33.7k exact looks made a step, ~1.2k were committed. The commit
  dropped every answer whose look wall key (lwv, the walls of 11x11 blocks
  around it) had changed since the post: in a battle nearly all of them,
  a few ticks later. Walkers then never held an exact record, approximated
  at every tile and listed a new 32-step look each time.
- Kept now (all deterministic, 0 and 3 helpers equal in flow-looks-commit,
  chaos-scenario-determinism, multiplayer-chaos-determinism):
  * The exact looks read a copy of each profile's walls made at the post
    (unit.js _flowWallSnap, parallel heap copy; mv.rs flow_wall_snap, word
    478): an answer is the post's state whichever helper makes it, when.
  * The commit keeps an answer whose wall key changed if its way still
    holds now: for ground looks, unchanged 8x8 wall-block counts around it
    since the post (mv.wallBlk now vs a copy at the post, words 477 / 479:
    walls_same_since_post) - no line test; else look_way_open (its block
    and straight line to its far tile; a short look's next tiles). Answers
    of no way still need an exact match.
  * The commit runs in SIM_FLOW_SPLIT parts a job (a burst of answers to
    revalidate had made one 50-67 ms chunk).
  * At a steer (flow_look), look_keep: a record whose wall version only
    changed is revalidated (same tile), and a walker that left an open
    look's tile toward its far tile carries it (nearer, >= 3 tiles out,
    block open, line open) instead of approximating.
  * Tried and removed: look_keep in the pending pass (foreground: its line
    tests cost 0.7 -> 2.4 ms a base tick in Edge, more than it saved).
- Numbers. Node 250k, single thread: exact looks made 27.9k -> 4.8k a step
  (with the pending keep), step 369 -> 324 ms. Node 1M, 8 helpers (prof
  build, tests/test-runs/occ-prof-20261111/keep3): mv_flow_exact helper time
  3,708 -> 2,611 ms (-30%), pending 449 -> 458, commit 258 -> 282, helpers'
  total 20.6 -> 19.5 s. Headed Edge 1M, interleaved A/B (A = these changes
  switched off, a scratchpad build via WASM32_OVERRIDE): ms a base tick A
  37.3 (dk 3.5) / 34.0, B 32.5 / 33.7 / 34.1; exact-lane waits A up to 12-13 ms,
  B none; commit chunk max A 8.7-16.9, B 4.1-12.6. The exact looks were
  background work, off the tick's path, so the tick barely moves: the
  saving is helper CPU and the lane's waits.
- Also: FPS fell over the session (86-99 early, 65-82 late) in A and B alike:
  the machine, not the code (interleave A/B runs).

## 2026-11-11 (night) — rendering apart from the simulation: measured, then garbage out

Goal (user): rendering costs the simulation as little as possible; no GC
spikes (no per-frame allocation); GPU and caches where they can; wasm/SIMD for
what stays expensive. Data in tests/test-runs/render-iso-20261111/.

- Measurement switches: ?render=0 (no frame drawn; the simulation's heartbeat
  and ticks as on a left-out frame) and ?present=0 (the presentation worker
  builds no frames). scene_tps_probe: WPROF now profiles the page too
  (<prefix>-page.cpuprofile), PAGEHEAPSAMP=file samples the page's
  allocations (collected objects included).
- What rendering costs the simulation (headed Edge, 1M chaos, interleaved,
  two runs each): full 32.5-33.5 ms a tick, no drawing 29.9-30.5 (the
  occupancy kernel's helper CPU 86 -> 74 ms a tick), neither drawing nor frames
  ran smaller steps at the same 20 TPS (headroom). Drawing ~9% of the tick.
- Where the CPU goes (60 s, profiles): page main thread ~39% busy (minimap
  ~20% of it: paintMinimapUnitColumns over every unit, its static layer and 2D
  calls, alerts; 2D terrain cache rebuilds 5%; frame apply 5%; combat effects
  4%; uploads 3.5%); presentation worker main ~36-55% + one helper ~17%
  (frameIdOrder sort, fillRange, buildRenderBuckets, markDirtySlots).
- Garbage (page allocation sampling, 40 s): 2.8 GB -> 550 MB.
  * Gone units' and structures' last values: a ~40-field object a death
    (1.7 GB of it) -> a ring of typed columns (pageGonePut / pageGoneGet,
    65,536 records, the record names its view).
  * The page's unit views on the fast path for slot moves (the relayout moves
    units every step; each move sent the page to the whole rebuild: a list of
    every unit and its pass) - _simClientUpdateStableSlots moves views.
  * TileEntitySet's generator iterator -> one iterator a loop, result reused.
  * Area colours array reused; Math.hypot in effects -> sqrt (argument
    lists); minimap alerts with fixed colours and globalAlpha (no rgba strings).
  * Presentation worker: the id sort's key array kept (8 MB a frame).
    (A kept-order attempt failed: the relayout moves slots every step.)
  * Simulation worker: simFrameReleaseBuffers ran at every returned frame,
    rebuilding its lists: now nothing when nothing is left.
- GC (trace, 60 s): page main thread 44 minor + 2 major, 360 ms, longest 81 ms
  -> 29 minor + 0 major, 79 ms, longest 5.5 ms. The simulation worker's major
  GCs (up to 29 ms) remain: its garbage is ~2.5 MB/s now (99 MB in 40 s, spread).
- Next: minimap from the GPU's unit columns (no CPU pass over units); the
  presentation worker's fill / dirty marks / buckets in wasm (frames in the
  heap) or on the GPU; 2D terrain cache rebuilds; the remaining page garbage
  (effects, building stat entries, area colour cache, cell item sort).
- Minimap units from the simulation (k.rs k_minimap, kernel 191): every 5
  ticks the worker paints a 160x160 picture of player numbers from the per-
  tile per-player counts (ix.complex) and the viewer's sight, a band of pixel
  rows a job on the helpers, into shared memory (two pictures in turn); the
  page maps it through its palette (renderer.js _minimapPaintWorkerPicture).
  No pass over the units anywhere (the page's was ~10% of its frame time).
  Checked in Edge: tests/probes/minimap-check.js (both armies' pixels).
- Ground tiles on the GPU for large maps (> 4096 px): an R8 wall mask a tile,
  only its changed rows uploaded (texSubImage2D + mipmaps), coloured in the
  ground shader; the 2D background is not rebuilt while the WebGL ground
  draws (its 2D redraw, mip and whole-texture upload at each wall change were
  ~5% of the page). The canvas 2D view rebuilds it when it draws.
- scene_tps_probe: SHOT=file.png (a screenshot at the end).
- Rendering's cost to the simulation after the page changes (headed Edge, 1M
  chaos, interleaved): full 30.5 / 31.7 ms a tick (before 33.5 / 32.5), no
  drawing 30.5 / 31.0: ~9% -> ~2-3%. p99 203 / 196 (before 215 / 292), max
  234 / 207 (237 / 389). FPS fell over the session in every variant; judge it
  by interleaved A/B only.
- Next: the presentation worker (~0.5 core: frame fill, dirty marks, id sort,
  buckets) into wasm kernels on the simulation's shared memory, its frames a
  pool in the heap made at match start; then the remaining page garbage.

## Presentation worker in wasm, multi-memory (2026-11-11)

- The presentation worker no longer touches a slot or tile in JS. Its module
  (wasm/build.cjs --pres -> src/sim/pres_wasm_bin.js; feature `pres`:
  wasm/src/pres.rs, pres_fill.rs; not in the simulation's module) has two
  memories: 0 its own (the unit frames as regions, the per-slot state: last
  ids, drawn positions, facings, ghosts, fill seq, easing, change stamps; the
  fog grids; scratch and address tables), 1 the simulation's heap
  (env.simMemory, sent with 'bind'), read in place: unit columns, metadata
  table, position snapshots, sight and cell grids. Nothing copied, nothing
  added to the simulation's heap budget.
- How: Rust can't emit loads from a second memory, so pres_fill.rs reads
  simulation data through imported `pres_sim_<type>(addr)` functions; the
  build prints the module as text (wasm-opt -S), drops those imports, turns
  every call into the load from memory 1 (`i32.load $simmem` ...), adds the
  import and optimizes again with --enable-multimemory (75-78 load sites).
  V8 (Node 24): loads from memory 1 as fast as from memory 0 (16M sequential
  10.8 vs 12.0 ms, indexed 17.1 vs 15.7 ms).
- Kernels: k_pres_range (a range's fill in its three modes, ghosts, change
  marks: one call a range, helpers each with their own instance, stack and
  argument block, the job's arguments written there by the presentation
  thread), k_pres_order (radix sort by id), k_pres_buckets, k_pres_fog,
  k_pres_moves (relayout), k_pres_cells (tile changes). Frames go out as
  {buf, base, rid, gen}; the page returns them by region id.
- The simulation side refuses a presentation that isn't in the heap
  (sim_presentation.js _simPresentMemory: columns, metadata, snapshots;
  wasm32 heaps only). Column types are checked by name in the worker.
- Equal to the old JS: the worker saved before the rewrite vs the kernels on
  the presentation-delta ticks, byte for byte (every live slot's columns, the
  order, buckets, marks; 90 frames, whole and by changes). Tests moved to a
  real simulation memory (tests/present-sim.cjs: the simulation's types,
  positions as eighths; tests/present-pm.cjs runs the worker in a context of
  its own).
- Speed, one thread, 1M slots, a heavy battle (~880k slots filled a frame:
  easing and turning after squads move): old JS fill 1830 ms, kernels 147 ms
  (~12x). Id order 210 -> 17.5 ms, buckets 27 -> 17 ms (when needed / a frame).
  Tried: the fill's ~12 passes over the filled list fused into one loop:
  3.5x slower in V8 (515 ms), reverted.
- Edge, 1M chaos, rendered, 60 s (one run each, tests/probes/present-phases.js):
  frame build 94.9 -> 62.4 ms mean, ranges 71.6 -> 37.8 ms, order 5.7 -> 6.5,
  rest 17.4 -> 17.7 (buckets ~17), max 983 -> 559 ms; 33.8 ms a tick, p99 205,
  80 FPS (variance as before: not an A/B).
- Next: the remaining 'rest' (buckets 17 ms a frame at 1M: SIMD or only the
  moved cells), the fill's per-slot cost (~170 ns a filled slot: profile the
  passes), structure/projectile table copies, the simulation worker's GC.
- Fill profiled (2026-11-11, later). Node bench, one thread, 1M slots, heavy
  battle (~880k filled a frame): ranges 147 -> ~90 ms.
  * The cause: cache-set aliasing. A frame's columns started at multiples of
    4 MB (cap 2^20), so the change marks (13 columns of two frames a slot, 26
    streams) evicted themselves on every slot: 81 ms, as slow warm as cold.
    Each frame and metadata column now starts SIM_FRAME_SKEW (64) bytes past
    the last one's end (sim_frame.js simFrameBytes / simMetaBytes; every size
    from those); presentation memory regions get a cache line of padding.
    Marks 81 -> 20 ms. The simulation heap's power-of-two columns have the
    same layout: worth checking for the simulation's own kernels.
  * Not the cause: loads from the second memory (as fast as memory 0), the
    extern-call model of them (now Rust stand-in loads LLVM sees as read-only,
    turned into memory-1 loads by the build: no change), one big function
    (the range is now kernels in turn, k_pres_select, k_pres_p0..p9,
    k_pres_finish, k_pres_tail: no change). The packed column lists use
    64-bit words (128-bit shifts were a call per slot and column).
  * Still identical to the old JS fill (both modes, byte for byte).
- Edge, 1M chaos: the worker now reports each step of its own range and the
  helpers' work and wait (tests/probes/present-phases.js). Ranges ~36-40 ms
  wall: this thread ~22-31 ms (select 4-6, facing 3-5, meta 3-5, tail 3-4),
  the slowest helper ~35 ms, ~8 ms waiting. Per filled slot ~3-4x the Node
  figure: memory shared with the simulation's 8 helpers. Helpers off: build
  113 ms (63 with), simulation unchanged (32.8 vs 32.4 ms a tick): kept.
- Next on the presentation thread: buckets (~16-18 ms a frame at 1M, serial)
  and the id order (~6.5 ms, sorted every frame in the chaos scene).
- Simulation heap checked for the same aliasing (1M chaos scene, headless
  tickbench, the 242 unit columns of 1 MB or more by address): none. Each heap
  array already ends SIM_HEAP_PAD (64) bytes later than its size (sim_wasm.js,
  for SIMD over-reads), so arrays allocated one after another start a cache
  line apart: by L1 set (64 sets) at most 5 columns share one (~3.8 on
  average: even), by L2 set (1024) at most 3. A power-of-two cap shifts each
  allocation by the same 64 bytes: spread the same way. Nothing to change.
  (The frames had no such gap: their columns were packed end to end.)

## Presentation: chunks, buckets in parts, order (2026-11-12)

- Edge, 1M chaos, the presentation thread's "rest" broken down
  (tests/probes/present-phases.js: buckets, marks copy, tables, cells):
  buckets 14 ms a frame, structure/projectile tables 3, cells 1.5; the id
  order 6-7. The helpers waited up to 23 ms: a range a thread, equal slots,
  unequal filled units (this thread ~16 ms of work, the slowest helper 35).
- Chunks: a frame's slots in parts*4 chunks (whole blocks), each taken by
  the next free thread (Atomics on a counter in the presentation memory;
  per-chunk result words). Wait 23 -> ~1-5 ms. The range phase stayed
  ~28-38 ms (run to run): every thread is now busy ~30 ms; the work is
  memory-bound beside the simulation's helpers. Frames byte-identical
  across thread counts (presentation-helpers).
- Buckets in parts (pres.rs k_pres_bucket_part / k_pres_bucket_merge): 16
  parts of the order from 65536 entries (whatever the threads: the same
  result), taken by this thread and the helpers, each its own lists a cell
  (and tails), largest move, moving slots; the merge joins a cell's lists
  last part first (k descending, as one pass), the largest move (f32 of the
  largest distance: rounding is monotonic, order-free), the moving slots in
  part order. Equal to the original JS bit for bit (2.1M entries, 16 parts).
  Edge: 14.5 -> ~6 ms a frame.
- The id order kept from the last frame and merged with the units new to
  it (instead of a sort): ~5x slower at 1M (74 vs 14 ms in Node, any churn):
  ids by slot are random, every look-up a cache miss; the radix sort's
  passes are cache-friendly. Reverted; the order is kept only for a frame
  whose membership did not change (as before).
- Frame build in Edge ~66 -> 50-54 ms (one run each; FPS 85-87, simulation
  31-33 ms a tick: within the spread).

## 2026-11-12 - movement / occupancy kernels: analysis and plan (no code change)

- Plan: MOVE_OCCUPANCY_OPTIMIZATION_PLAN.md. Raw data: tests/test-runs/move-occ-plan-20261112/
  (prof-build helper profiles, occ-sched-probe output, dbgc counters, counters.cjs).
- Node, chaos-1m-250k, 8 helpers, 30 ticks: tick 129 / 159 / 209 ms (p50 / p95 / max, prof build);
  helper CPU a tick: mv_move_occupancy 246 ms (24% of helpers), mv_move 113 ms (11%), all 1,023 ms.
- Kernel 89 a tick: 3,624 jobs, 521k index entries read, 350k units past the need mark, 189k resolved
  at ~740 ns each (15-20 cache lines of unit columns in spatial order), 633k motion calls (3.4 a unit:
  blocked diagonal -> x -> y -> four shoulders), 491k footprint tests, 72k shoulder searches, 38k swap
  looks (748 done), 56k yields. Per-job fixed work ~8 us (leader_dir, cache_chunks, zeroed buffers,
  Mv::load) = ~29 ms. Every footprint in play is a 1x1 / 3x3 / 5x5 square.
- Kernel 8 is flat (step4 16%, combat4 16%, move_flow 16%, move_pre0 13%, step_slot 11%): 308k of
  816k lanes one by one; only ~60k of 300k walkers on the steady vector step.
- Planned: mover records made by the first stage (32 bytes, per block bucket, sorted by tile and id),
  the second stage resolving from records and a 49-bit window word (8 direction masks, no repeated
  footprint tests), steering vectorized in the first stage, a slot-order apply pass. Estimate: kernel
  89 246 -> 40-70 ms CPU, movement 359 -> 180-230 ms. Remaining after that: kernel 8 (own pass).
- Later the same day (plan rev 2; outcomes need not match bit for bit, determinism and approximate
  behaviour must hold): measured at dk 4 too (DK=4, new option of occ-sched-probe and the counter probe):
  step 197 / 252 / 258 ms, mv_move_occupancy 321 ms and mv_move 132 ms helper CPU a step; 1.19M footprint
  tests, 121k shoulder searches, 45k swap looks for 1,345 swaps (97% futile), 101k epilogue slots; only
  161-996 units a step end fully blocked. Kernel 8 at dk 4: move_flow 38%, 68k of 150k steers in the
  tile of the last steer, step4 finishes ~10k of 300k walkers.
- Rev 2 design: A (mv_move: requests, vector steering, same-cell steps finished) -> B (block jobs:
  bucket radix-sorted by position along the heading and id, window word + preference table per cell
  step, integers only) -> C (mv_move_apply by slot chunks: columns, epilogue, index; the JS tail gone).
  Then steering by target instead of ticks, a wake wheel for parked units. Estimate: movement ~2x,
  2-2.5x with the steering rework; kernel 89 4-6x.
- Plan rev 3 (no half measures): helper CPU by family, dk 1 / dk 4: occupancy 246 / 321 ms, steering looks
  (mv_flow_*) 169 / 281, mv_move 113 / 132: movement in all 545 / 760 ms = 53 / 47% of the helpers; then
  acquisition 57 / 208, worker search 33 / 127, visibility 29 / 93.
- Tick-based windows collapse at dk 4: SIM_FLOW_REFRESH_TICKS 4 makes refresh true every step, the steer
  window (16 base ticks, 4 near) is 4 steps or 1: 150k move_flow calls and 71k exact looks a step.
- Prototype (tests/test-runs/move-occ-plan-20261112/mvproto, Rust wasm32 simd128, one thread, 484k units all
  walking, block-ordered rows, 4-lane step, radix order, window word + preference table, publish):
  33 ms a step at dk 1 (69 ns a unit), 47 ms at dk 4 (97 ns); parts: step 3.4 ns, order 14, resolve
  45-70, publish 6-10 (shuffled slots +10). Today 740-940 ns a unit for kernels 8 + 89.
- Rev 3 design: a persistent block-ordered mover table (~38 bytes a row, SoA slabs of 64 a block, dirty
  marks + audit), one job a block (step, order, resolve, publish), everything else as events (steering by
  look not ticks, wheels for wakes and shots, epilogue in block batches). Estimate: kernels 8 + 89 4-7x,
  movement with looks 3-5x, the helpers total 1.5-1.7x (movement cannot give more than ~2x alone).

## 2026-11-12 - movement plan stage 1: steers by look, not by ticks (mv.rs)

- Plan: MOVE_OCCUPANCY_OPTIMIZATION_PLAN.md, stage 1. Raw data: tests/test-runs/move-occ-stage1-20261112/
  (builds by step, counters, helper profiles in prof/ and final/, behaviour/ old against new).
- A steer (the record SR) now holds until its look ends, not for 16 / 4 base ticks: SR_CN is its target
  point (the look's far tile and side offset, packed), SR_CT an end tick only within 64 tiles of the
  destination (8 base ticks, 4 within 8 tiles: the arrival in a crowd), SR_STEADY negative = diverted by
  the footprints, aimed at the target again by the vector step. The vector step (step4) heads for the
  target (re-aim in f32, exact operations), crosses tiles at any step size (seg_open at several base
  ticks a step), carries the steer and the floor look over a tile change itself (steer_hold) and stops
  a step short of the target. The scalar step (held_step: step_flow and move_flow's head) does the same
  with the unit's speed. SIM_FLOW_REFRESH_TICKS is gone (a steer always checks its record).
- Looks: a unit on a held steer is not listed (mv_flow_pending) until it is within LOOK_CARRY_MIN tiles
  of its far tile (the next look asked ahead) or needs one; an answer that names the far tile the steer
  already heads for leaves the steer standing (mv_flow_commit), any other ends it.
- Helper CPU a step, chaos-1m-250k, 8 helpers, prof build (tests/profile-families.cjs over
  occ-sched-probe PROF= profiles; the plan's baseline reproduced by the same script):

  | | dk 1 before -> after | dk 4 before -> after |
  |---|---|---|
  | steering looks (mv_flow_*) | 169 -> 87 ms | 281 -> 127 ms |
  | mv_move (8) | 113 -> 94 | 132 -> 102 |
  | mv_move_occupancy (89) | 246 -> 206 | 321 -> 285 |
  | all helpers | 1,012 -> 811 | 1,596 -> 1,281 |

  Step time, release build (tests/move-step-probe.cjs, 30 steps): dk 4 p50 / p95 / max 155 / 194 / 205
  -> 134 / 167 / 168 ms; dk 1 93 / 114 / 118 -> 87 / 114 / 118 ms. Looks listed a step 95.7k -> 48.0k
  (dk 4), 54.0k -> 35.1k (dk 1). move_flow calls a step at dk 4: 150k -> 64k; lanes done four at a time
  341k -> 433k.
- Two faults found by the checks and fixed:
  * multiplayer-chaos-determinism diverged at tick 7 (host against guests): the steer's carry compared
    its record's wall key with another 8x8 block's. The keys (mv.wallBlk9) are each peer's own change
    counts; only "the same block, unchanged since" is the same on every peer. The carry now stays in the
    look's block; another block is move_flow's (look_keep, by the line test).
  * rally-pulse --dk=4: the crowd settled 4x slower with the destination windows in steps (the arrival
    is tested at a timed steer). Back to base ticks (4 near, 8 further out: at 16 a crowd settled ~25%
    slower at dk 1 too, a walker used to steer at every tile). Idle at 10 s: dk 1 99.5% before, 99.6%
    now; dk 4 97.1% / 93.5% (99.7% / 99.1% at 15 s).
- Checks passing on the final build: flow-looks-commit, nav-look-cache-wall, nav-flow-width,
  traffic-pressure, occupancy-grid, occupancy-shapes, worker-approach-occupancy, deterministic-sort,
  lockstep-hash-stream, chaos-scenario-determinism and multiplayer-chaos-determinism (both also with
  SIM_WORKER=1); crowd-flow.bench advance 1575 / 1575 (dk 1), 6260 / 6258 (dk 4).
- Tried, not kept (stage 2's first half): the resolve reading a mover's bitmap neighbourhood once
  (16 rows of 64 cells, own cells cleared) and testing every candidate sweep against it. Outcomes
  identical (the same position hash over 484k units, 20 steps, dk 1 and dk 4), no gain: kernel 89's
  wall 32.1 -> 33.5 ms (dk 4), 22.5 -> 24.8 (dk 1). The footprint tests are not what costs; the unit
  columns read in spatial order are (finding 1 of the plan). Source kept beside the data
  (occ-window-resolve-not-kept.rs).
- Remaining, by helper CPU at dk 4: mv_move_occupancy 285 ms (checked_traffic_q's own lines 41, motion
  and the footprint leaves ~70, traffic_swap 22, move_job's visit 20, epi_slot 20, leader_dir 13,
  resolve_slot 12, traffic_yield 11, cache_chunks 10), acquisition 178, looks 127, worker search 112,
  mv_move 102 (step4 27). The looks left are short ones in built-up ground: ~25k units a step within
  three tiles of an open look's far tile, ~9k on approximations. Not done: plan stages 0 (prototype
  questions), 2 (preference table), 3 (the mover table), 4 (events and wheels), 5, 6.
- New tools: tests/move-step-probe.cjs (step time, kernel walls, looks listed, a position hash for
  comparing builds), tests/profile-families.cjs and tests/profile-self.cjs (helper profiles by kernel
  family / by function under a kernel).

## 2026-11-12 - movement plan stage 3a: the mover table, its marks and audit (nothing reads it yet)

- wasm/src/mvt.rs: the table (one row a unit with a footprint, 8 words: x, y, the steer's target, slot, id,
  rtEnd, statRow | radius | layer | mvNP, mvOn | mvFlags | cmMode | owner), slabs of 64 rows as arrays, a
  chain of slabs a block (the occupancy's blocks), mvt.hrow by slot. Kernels: mvt_rebuild (whole, from the
  columns), mvt_sync (the slots marked in mvt.dirty: rows written in place, moved to another block, made or
  taken away; sixteen marks a compare), mvt_audit (every row against the columns, every chain against its
  count). The class, the wake and the hand are not in the row yet: they come with the block job (3b).
- JS (sim_occupancy.js mvtEnsure / mvtBeforeMovement / mvtAfterMovement / mvtCheck): the arrays in the wasm
  heap, sized once from the slots' capacity (slots / 64 + blocks slabs); the sync before the movement's
  kernels. Kept only when asked for (?mvt=1; ?mvt=2 audits before every movement and throws; the tests'
  MVT=1 / 2; MVT=3 collects one of each kind of difference and prints them at exit, tests/mvt-seen.cjs):
  without the flag nothing is allocated or run, the marks are a null test. The movement's own writes are
  not marked one by one yet: every slot is marked after it (so the table costs a full remake a step while
  on: 3b makes the block job the rows' writer).
- The marks: a write of a column a row is made from goes through mvtM(slot) / mvtS(steer word) in its index
  in JS (78 writes in unit.js, main.js, sim_unit_state.js, sim_occupancy.js, things_utils.js: the index
  wrapper cannot be left out at a branch); in kernels k_slot_zero (a slot made fresh), k_unit_gone_par (let
  go), k_slot_move (both slots) take '?mvt.dirty'; a compaction and a decoded snapshot make the table whole.
  A unit that died is not marked (seven kernels set unit.dead): the sync counts dead-and-live slots as
  marked (two more byte columns in its compare).
- What the audit found on the way (each a desync-in-waiting once rows are read): births without a mark;
  deaths set by seven kernels; slots moved by the relayout; marks of released slots past the count of slots
  in use (the sync and the audit now scan the capacity, not the count); a rebuild after a smaller state
  left row indices at slots past the count (cleared by capacity).
- Checks: tests/mover-table.test.cjs (audited battle; an unmarked write and an unmarked move across a
  block's edge are found, marked ones synced and re-homed; the table kept step by step equals one made
  whole; a dead unit loses its row). Every tests/*.test.cjs with MVT=2: 281 / 282 (research-menu fails
  without the table too, and on the build before these changes); the same without the flag; chaos and
  multiplayer chaos determinism with SIM_WORKER=1 MVT=2. chaos-1m-250k, 8 helpers, dk 4, 45 steps: the
  audit passes every step, the position hash is the same with the table off, on and audited.
- Cost while on (chaos-1m-250k, dk 4, step p50): 137 ms off, 146 ms kept (the serial remake of ~480k rows a
  step), 166 ms audited. Off is the default: no change in play.
- Not done (3b / 3c): the block job reading rows, the marks inside the movement kernels (or rows written
  there), sync and re-homing by block on the helpers, the permuted-row-order test, the old paths deleted.

## 2026-11-12 - movement plan stage 3b, first part: the block job walks the mover table

- The table is live (no flag): mvtBeforeMovement runs from occupancyPrepareMovement (rebuild after a restore,
  else mvt_sync of the marked slots), and writes occ.offsets (each block's rows before it) itself. The count
  kernel (97, occ_block_counts) and occ_prepare are deleted.
- mv.rs move_job (kernel 89): the block's rows gathered from its slab chain (those with the first stage's
  mark, a push at their tile, or no footprint), entries [id, tile key, slot, row] in the thread's scratch,
  LSD radix (8-bit passes, constant digits skipped) by tile from the far end of the block's heading (the
  integer sum of the wanted steps), then id; visited in that order. leader_dir, row_live, the index visit
  loop, tile_range and the unlisted second-pass loop are deleted. Behaviour change: inside a tile the order
  is by id (was the index's order).
- occ.rs: MoveGrid holds the table (Rows); commit_preview and the swap write the row's position with the
  footprint record. A move into another block leaves the row where it is and marks the slot: the next sync
  re-homes it. A unit without a footprint gets its row's position at the gather.
- The row is now one a live unit: x, y, slot, id, radius | layer | footprint, owner. statRow and mvNP were
  in it after 3a and are out again: with rows no longer remade every step the audit is a real check, and it
  found kernels writing both without marks (level scaling, the controller's arms). Nothing read them.
  (3a's audit ran after a blanket mark of every slot, so it could only find births, deaths and slot moves.)
- A desync found and fixed on the way (tests/shared-spatial-determinism, flaky): the job takes its scratch
  from words 1000 / 1001 of the argument block, which only _simRust's kernels set; a helper whose first
  kernel was 89 had none and returned without resolving its blocks. The kernel's wrapper sets the words;
  the job traps (unreachable) on no table, no scratch or more rows than the scratch holds, never skips.
- ?mvt=2 / MVT=2 now audits before and after every movement; ?mvt=3 collects differences.
- Checks: tests/mover-table.test.cjs (real move orders now: issueMoveOrder never existed), new
  tests/mover-table-order.test.cjs (every block's rows reversed before each movement, the table made whole
  every tenth tick: positions equal at six checkpoints over 300 ticks of two crowds crossing). All
  tests/*.test.cjs: 282 / 283 plain, 281 / 283 with MVT=2 (research-menu fails before these changes too;
  multiplayer-snapshot under MVT=2 corrupts unit.x on purpose, which the audit reports), the chaos /
  determinism / restore tests with SIM_WORKER=1: 11 / 11.
- Measured (chaos-1m-250k, 8 helpers, 15 warm-up + 30 steps, tests/move-step-probe.cjs; data in
  tests/test-runs/move-occ-stage3b-20261112/):

  | | stage 1 final | rows (two runs at dk 4) |
  |---|---|---|
  | dk 1 step p50 / p95 / max | 87 / 114 / 118 ms | 89.6 / 115 / 115 |
  | dk 1 k89 / k8 wall a step | 22.5-24.8 / 9.7 | 24.9 / 10 |
  | dk 4 step p50 / p95 / max | 131-134 / 167 / 168-170 | 144 / 180 / 183 and 137 / 167 / 172 |
  | dk 4 k89 / k8 wall a step | 32.1-33.5 / 10.8 | 36.2 / 11.8 and 33.5 / 10.9 |

  No gain yet, as expected of this part: the job still resolves each unit from its record and columns;
  only the visit's source changed. New serial cost: mvt_sync 4.2 ms a step at dk 4 (11,050 marked rows a
  step: block changes, deaths, births) on the simulation thread.
- Remaining: the sync / re-homing by block on the helpers (the 4.2 ms); the gather reads the need byte in
  each unit's footprint record (one scattered line a row): the class in the row removes it; then the step
  and the resolve from rows (the plan's 4-7x on kernels 8 + 89 is all there).

## 2026-11-12 - movement plan stage 3b, second part: the sync off the simulation thread, the first stage's results in one word

Outcome-identical to the first part (position hash by id after 17 steps at dk 4, no helpers: 395310288, 412,089
alive, both builds).

- **The mover table's sync** (was mvt_sync, 4.2 ms a step at dk 4 on the simulation thread). First tried as two
  helper dispatches before the movement: 3 ms, no better: an empty dispatch costs 0.01 ms, but at that point of
  the tick the helpers are in background lanes and the simulation thread ran most chunks itself. Now:
  - the scan is part of kernel 8 (mv.rs move_job, first stage: each slot chunk's marks at the chunk's start,
    before its units step; mvt.rs scan_chunk, the table's addresses in mvt.cfg[16..]): a row in the same block
    written in place, else marked gone (slot word -1) and the slot listed with its position (two words);
  - mvt_sync_plan, one job on the simulation thread after kernel 8 (marks past the slots in use, the blocks with
    changes, the entries by block, occ.offsets from the counts the block pass will leave): 0.3-0.5 ms unloaded;
  - mvt_sync_apply on the helpers (k_block 5, 16 blocks a job): a block's gone rows closed up from its tail, its
    listed rows put in at their listed positions (the columns hold wanted positions by then). Free slabs under
    a spin lock; the pool has a slab a block more; when it could still run short the pass runs in two rounds
    (rows out, then in: tests/mover-table.test.cjs runs both).
  - A row's position is its footprint record's (the columns' only without a footprint); the audit between the
    stages (?mvt=2: 'between the movement's stages' and 'after the movement') compares accordingly, and outside
    the movement also checks the columns against the record.
  - Pitfall met: simRustParallel writes its selector to _simParams[0], the movement's own params by then.
- **The first stage's results for the second**: occ.needb, a bit a slot (was a byte in each footprint record: a
  scattered line a row of the gather), and the record's word 3 (mv.rs FW_*: class, flags, brain mode, profile,
  output code, spent). resolve_slot, checked_traffic_q, walker_short_at and yield_tag take that word; the
  position and output columns are written only where they change.
- **MoveGrid's chunk cache** is filled at the job's first swap look, not at its start.
- Checks: the table / determinism / restore / snapshot / multiplayer-chaos tests with MVT=2: 15 / 15 (the
  multiplayer-snapshot failure under MVT=2 is gone: the audit reads the record). All tests/*.test.cjs plain:
  282 / 283 (research-menu fails as before these changes).
- Measured (helper CPU profile, dk 4, chaos-1m-250k, 30 steps; another program held ~40% of the machine during
  the later runs: all kernels read ~14% high, so the second column is also given scaled by the total's ratio):

  | under mv_move_occupancy | first part | second part | scaled |
  |---|---|---|---|
  | all | 326 ms | 367 | 322 |
  | move_job self (gather, order, second pass) | 40.3 | 51.1 | 44.8 |
  | checked_traffic_q self | 45.3 | 50.6 | 44.4 |
  | resolve_slot + walker_short_at | 25.0 | 24.0 | 21.1 |
  | chunk cache | 12.6 | 7.9 | 6.9 |
  | sync on the helpers (scan in kernel 8 + block pass) | - | 9.6 | 8.4 |

  Step wall times of this session are not comparable with the first part's (machine load): 152-181 ms p50 at
  dk 4 against 137-144; rerun both builds on a quiet machine before quoting a step time.
- What this says: kernel 89's time is not in the class / flag / output columns. It is the footprint sweeps
  (motion, free_*, horizontal_motion, preview, commit: ~95 ms), the resolve's own arithmetic and its remaining
  lines (the wanted position columns, the steer record, the record), swaps (~28), the epilogue (~22). The plan's
  gain needs the new resolve (window word, preference table) and the step from rows, not more column packing.

## 2026-11-13 - movement plan: the resolve as a cell walk, tried and not kept

The tree is the second part's (the kernels' binary byte-identical to it). The attempt is kept as source in
tests/test-runs/move-occ-stage3b-20261112/walk-resolve-not-kept.occ.rs / .mv.rs (MoveGrid::walk, its call in
checked_traffic_q), its profile in prof-walk-dk4.json.

- What it was: a step resolved cell by cell (radius <= 3): the unit's own cells cleared, per cell step the 7 x 7
  cells around it as one word, the wanted move (toward the target's cell) and then the moves an eighth and a
  quarter turn to either side as masks of that word (the hand side first), refused into walls, past the halo
  or farther than the step's length; marked where it ends. It replaced preview / motion / the shoulder search
  / commit_preview in checked_traffic_q. Integers only (one exact sqrt pair for a sub-cell move).
- Measured (helper CPU profile, dk 4, chaos-1m-250k, quiet machine): kernel 89 322 ms (second part, scaled)
  -> 297 (walk 91) -> 304 with the rows kept over the walk (walk 101) -> 294 with the job's rows read up
  front (walk 94, the reads 10). 250,707 walks and 934,615 cell iterations a step (3.7 a walk).
- Behaviour (tests/crowd-traffic.bench.cjs, progress summed over 3,200 units): open march at dk 4 +5%
  (1,458k against 1,384k at tick 60); plug at dk 20 equal; counter at dk 20 -0.7%, at dk 1 +3%, at dk 4 -5.5%
  (4,528k against 4,790k at tick 200, 72-79% of the units moving a step against 96-98%). tests/traffic-pressure
  fails on the counter case (90% moving at tick 80, 95 asked). Two things the old code does that matter there
  and that the walk had to copy: a blocked unit closes up inside its cell along its step, and a unit whose free
  side cell is farther than its step moves toward it inside its cell (short steps cross over after a few).
  Limiting side moves to steps short of four fifths of their length (the old shoulder's rule) did not help.
- Not the walk's cost (each tested by a build): re-reading the rows a cell step; the rows a footprint cannot
  reach; the first read of the block's bitmap lines. So it is the iteration's arithmetic, not memory: to be
  split into profiled pieces before another attempt.
- Pitfalls met: the module may have no data segments (a static table fails the build: tables as packed
  constants or arithmetic); the bench's default is --dk=20, the test's case too.
- Next: the step from the rows (kernel 8's 115 ms) rather than the resolve.

## 2026-11-13 - the step from rows sized before starting; where the simulation thread's step goes

Nothing changed in the kernels. Two measurements on the second part's build (chaos-1m-250k, dk 4, 8 helpers, 30
steps; tests/move-step-probe.cjs MAINPROF=file gives the simulation thread's profile).

- **The step from rows** (kernel 8's steady step, step4, in the block job). Kernel 8 is 114 ms of helper CPU and
  ~11 ms of the step's wall; step4 is 33-37 ms of that CPU (29%): moving it is worth about 3 ms of a ~137 ms
  step. step4 is not memory-bound (its ~25 streams are read in slot order) but check-bound: per walker the
  steer record (steady, target, committed step, its tile, the floor's tile), the flow field as made (its
  generation, destination, ready), energy, the index entry, the tile's hostile structure once a second. A row
  could only replace those reads if the row were the walker's state and every one of those checks an event
  (the plan's stage 4: wheels, field and wall events): the steer record is written at ~30 places in mv.rs. So
  it cannot be done as a part on its own, and its gain is small until stage 4 exists.
- **The simulation thread, a step** (profiler on: 153 ms p50): 94 ms inside parallel dispatches (shared with
  the helpers: kernel 89 ~34, kernel 8 ~11, the rest), 11.5 ms waiting for background lanes, and **50 ms
  serial: 35.5 ms JavaScript, 14 ms wasm called directly**. Serial time is wall time one for one. Its owners:

  | ms a step | where |
  |---|---|
  | 6.6 | processGlobalSpawnerQueue > _processSpawnsByTables |
  | 5.4 | simMoveRun > combatScanRun (its serial part) |
  | ~7 | unitHitsResolve (recordDamageVisual 2.2, _structHitsApply 2.1, own 1.8, recordUnitAttackFx 0.7) |
  | 5.4 | workerSearchTierStep (_wsCommit 3.6, _wsPost 1.8) |
  | 2.8 | k_worker_ai (direct) |
  | 2.2 | unitEventsRun > waiOutEvents |
  | 1.2 each | researchQueueSpend, towersTick, navFieldsSweepStep, simUnitStateDetachGoneMany |
  | 0.8 | mvtAfterFirstStage (the table's sync: was 4.2 serial) |

  A third of the step is serial work on the simulation thread; that is a larger and surer target than either
  movement kernel's remaining parts (tests/test-runs/move-occ-stage3b-20261112/main-thread-dk4.txt).

## 2026-11-13 - the acquisition post's copies made only when their source changed

The largest single serial item on the simulation thread at dk 4 (chaos-1m-250k): unit.js _acqPost, 5.4 ms a
post, and a post runs every step at dk 4 (every fourth tick at dk 1).

- By source line (tests/profile-main-serial.cjs for the owners; the cpuprofile's positionTicks for the lines):
  4.3 ms was `acq.anb.set(area.nb)`, the area graph's neighbour list copied whole into the job's own array at
  every post: 16.8 MB at this map, and the areas are made once a layout. 1.8 ms was simParallelCopyHeap on its
  serial path (2.6 MB, under SIM_COPY_PAR_MIN): 2 MB of it the per-tile structure tables (mv.struct, mv.scls),
  which change when a structure is made or goes.
- Now (_acqKept): the area graph is copied when _simAreaLayoutVer or one of the four arrays is another; the
  structure tables when _simMoveStructVer (new: counted at their two writers, k_move_structs in unit.js and
  k_struct_destroy in things_utils.js) or an array is another. acqTierReset forgets both.
- Outcome-identical (position hash by id, no helpers, dk 4: 395310288, 412,089 alive, as before); the
  acquisition / tower / combat / area / determinism tests 15 / 15; all tests/*.test.cjs: 282 / 283
  (research-menu fails as before).
- Measured (the simulation thread's profile, 30 steps, quiet machine): combatScanRun's serial part 5.36 ->
  1.61 ms a step; the thread's serial time 49.6 -> 44.5 ms a step (JavaScript 35.5 -> 31.3). Step p50 142.5-145
  ms in three runs; the step's run-to-run spread (about 5%) is larger than the 3.7 ms.
- Left in it: simParallelCopyHeap 1.0 ms (the hostile tables and the cover, 0.5 MB, and the structure tables on
  the steps a structure changed: in this scene most).
- The simulation thread's serial owners now, ms a step: the spawner queue 6.4 (_processSpawnsByTables: a unit at
  a time in JavaScript: _spawnStats 0.9, _simUnitObjInit 0.4, _spawnEnd, simSpawnBatchAdd, occupancySpawn...:
  the batch births of UNIT_BIRTH_WASM_PLAN.md do not cover it yet), the worker search's commit and post 5.4,
  k_worker_ai 2.8, waiOutEvents 2.2, _structHitsApply 2.3. Caution reading this profile: the probe runs the page
  and the simulation in one context; in the browser the per-hit visuals (recordDamageVisual, recordUnitAttackFx,
  playSound) are the worker's event recorders (sim_worker.js _simRecord*), not these functions.

## 2026-11-13 - the spawner queue sized; the flow looks' wall snapshots copied on change

- **The spawner queue** (barrack.js _processSpawnsByTables, 6.4-6.8 ms a step at dk 4 on chaos-1m-250k): 195
  spawns a step (5,857 in 30), ~35 us each, no single waste. _spawnBegin 3.3 ms (simSpawnBatchAdd 2.8: the unit
  object and its slot, its worker set-up 0.4, _simUnitObjInit 0.4; _spawnStats 1.0: 6.7 template misses a step
  at ~150 us, each a research finishing for that owner and type, 53 keys live), _spawnEnd 2.0 ms (the batch's
  finish with the footprint 0.4, the rally: its target, its path template, the path's store), the production
  pass itself 0.7. It is a conversion (spawns as rows through the batch-birth kernels with lazy unit objects,
  the rally as a queued order), not a removal: not started.
- **The flow looks' wall snapshots** (unit.js _flowWallSnap, 0.6 ms a post): a megabyte a profile and the wall
  blocks' counts copied at every post; now when a wall table was written since (_simWallsEpoch: counted at the
  tile changes' kernel and the whole rebuild) or an array is another. Outcome-identical (hash 395310288 at dk 4,
  no helpers); wall / flow / nav / restore / determinism tests 20 / 20. In this scene structures change every
  step, so the snapshot (and _acqPost's structure tables) is still copied on most steps: the gain is in
  calmer play. To cut it here the copies would have to follow the changed tiles (the tile changes' list).
- Tried and reverted: the small heap copies through the copy kernel on this thread instead of TypedArray.set:
  the same time (2.2 ms a step for ~3 MB): the copies are bound by memory (lines last written by other
  threads), not by the call.
- **The simulation thread now** (30 steps, quiet machine): serial 42.3 ms a step (JavaScript 29.7, wasm 12.6),
  from 49.6 at the start of the day; parallel dispatches 87.6, background waits 13.4; step p50 141.7, p95 172.7
  (tests/test-runs/move-occ-stage3b-20261112/main-thread-dk4-after.txt).

## 2026-11-13 - the worker search's takes on the helpers; where the simulation thread's background spikes come from

- **The takes in the parallel pass.** The search tier's commit (worker.js waiTake) ran the worker kernel over
  every found request on the simulation thread (k_worker_ai mode 1, serial: ~3 ms a step at dk 4 on
  chaos-1m-250k: heal_find, take_one, can_assign...). The parallel pass (k_wai_decide on the helpers, then
  k_wai_apply with its rounds for contended sites) has supported takes since it was written; the dispatch was
  narrowed to the events (mode 0) on 2026-11-04 when the return spawners' results were added, with no reason
  logged. The take path writes only the worker's own columns directly (wsfail, its record) and the rest
  through the overlay, so: `WAI_PARALLEL && mode !== 2`. _wsCommit's serial time 3.9 -> 1.6 ms a step.
  Behaviour: contended takes settle by the apply's rule (lowest id keeps a site, the others try again, up to
  16 rounds) instead of the search's order: worker-take-rounds matches 8 of 10 sites by its end in 4 rounds
  (serial: 7); the test now asserts the rounds are used and match at least as many as the serial pass, not
  equality with it. Tests: the 15 worker tests; multiplayer-chaos-determinism (six maps, 2610 tick hashes)
  without helpers and with the host on 4 real helpers.
- **The commit deferred a step** (the session before: a search posted in a step of three or four base ticks
  was taken in the same step, so its commit waited for a chain posted moments before and this thread ran it;
  now taken at the next step's start, the grid's sweep slices of the base ticks in flight held and run after
  the commit): in place, with the takes above.
- **Tooling.** tests/move-step-probe.cjs TRACE=1: the parallel layer's per-step trace (sim_parallel.js
  _simParTrace) on a real clock (the harness's performance is virtual: every bgc / bgAge in it read 0), the
  helpers' background time per lane and per kernel (new probe-bound par.bgus, counted in the helper loop only
  while tracing: hbgms:<lane>, hbgk:<kernel>); TRACEKEYS=regex prints the matching keys per step. _wsPost adds
  ws:total / ws:nfPairs to a trace. tests/test-runs/ws-commit-20261113/sumtrace.cjs sums the simulation
  thread's own background chunks (bgc:) per step and lane.
- **Why the simulation thread runs background work** (chaos-1m-250k, dk 4, 8 helpers; trace-*.txt there):
  the helpers are saturated. Background lanes take ~550 ms of helper CPU a step (by kernel: flow looks' exact
  pass 152 ~92, nav build 135 ~70, acquisition scan 33 ~65 + area answers 98 ~31 + counts 137 ~17, worker
  search scan 39 ~42 + nearfield 99 ~29 + return spawners 136 ~19, visibility seed 28 ~41, combat brain 62
  ~24), beside the foreground dispatches (~95 ms a step on 9 threads). Whatever lane is lowest in
  SIM_PAR_BG_ORDER when its wait comes is left to this thread: 13.5-16 ms a step on average, in spikes:
  - every 8 steps (32 ticks) 22-35 ms of the worker search's scan (lane T1) plus 10-15 ms of the traffic
    solve: on the step before, the flow looks' lane takes ~200 ms of helper time (25-50 on other steps; three
    steps in a row of bursts) and it is ahead of T1. Not the search's size (its posts are 9-32k requests with
    no pattern) and not stale bindings (hskip4 0).
  - every 4 steps 18-40 ms of the nav build chain (lane LONG, last in the order): its stage gap is 1-2 steps
    at dk 4 (_navStageGap) and the lanes ahead use all of it.
  Reordering lanes only moves the leftover (every lane here is due the next step); the fix is less helper
  work: the collectors' groups and their nearfields remade at every post in a scene whose structures change
  every step (incremental from the tile journal), the flow looks' bursts, the acquisition scan.
- Measured (30 steps each, same machine; step p50 varies ~5% run to run): the simulation thread's serial owners
  (main-serial-before/after.txt): _wsCommit 3.9 -> 1.6 ms; serial total 47.0 -> 47.2 (the spawner queue read
  6.7 -> 7.5 and recordDamageVisual 1.9 -> 2.4 in this run: noise and the scene's own variation; the take is
  the only change). Trace runs: step p50 151.3 -> 144.5, mean 154.2 -> 152.0, p95 191.2 -> 191.0, max 192.2 ->
  215.6 (a nav-chain step, 40 ms on this thread); its background chunks 13.5 -> 16.3 ms a step (lane T1 2.3 ->
  4.8: the takes' decide is now a foreground job on the helpers the scan shared). Net: not distinguishable from
  noise in step time; the serial part is gone from this thread, the spikes are the next target.
- The serial owners now (ms a step): the spawner queue 7.5 (a conversion: UNIT_BIRTH_WASM_PLAN.md),
  _structHitsApply 2.4, waiOutEvents 2.2, _wsPost 1.9, unitHitsResolve's own 1.8, researchQueueSpend 1.3,
  combatScanRun 1.3, navFieldsSweepStep 1.3.

## 2026-11-13 (later) - the near fields kept up to date; the spawner queue as births in wasm

- **The worker search's nearest-spawner fields incremental** (k.rs nearfield_incr, k_ws_nearfield mode 3, a job a
  field, before the whole-field stages): a field holds its nearest spawner's tile (was steps << 16 | rank: every
  value changed when the set did, so each post made both fields whole: ~29 ms of helper CPU a step at
  chaos-1m-250k). Per field slot (wsg<g>.nfa) its owner, grid and the spawners it was made for; at a post the
  spawners now against them: a gone one's cell (connected: every tile's way to its nearest stays in its cell)
  cleared and given the nearest of the spawners on the cleared tiles' edge; a new one's cell flooded from its tile.
  Made whole (modes 1 and 2, then ranks turned into tiles) only for a new slot owner or grid, changes past half of
  the spawners, or past the thread's scratch. The scan finds the spawner by halving its tile in tile order (rk, pid).
  ws-nearfield-split: the kept fields equal the one-job whole form tile by tile over eight rounds of spawners placed
  and destroyed (one round made whole). Helper CPU of kernel 99: ~29 ms a step -> gone from the top of the list.
- **The spawner queue as births** (UNIT_BIRTH_WASM_PLAN.md "Production spawns"): spr.rs k_spawn_births does every
  spawn of the step (checks, exit, footprint before the slot, slot, handle, id, core, stats from the effective rows,
  worker set-up, id index, the spawner's own changes, the rally); units have no objects until JavaScript asks; the
  workers' rallies are a worker-pass event (wai.rs rally, code 6). The JavaScript path is gone (_spawnBegin /
  _spawnEnd, the one-by-one spawn, the JS ready lists and scheduler, batch spawns, rally templates,
  applyWorkerRallyFromSpawner, the per-owner spawn path budget). The sweep's dirty tiles are a typed list
  (workSiteDirtyList). Fixed on the way: k_stat_fill never filled eff.rWch (a scout's watch was 0 after a kernel
  stats change); the production pass skipped a class whose columns were outside the heap, silently (now moved there,
  else thrown). Simulation thread (chaos-1m-250k, dk 4, 8 helpers): the spawner queue 7.5 -> 1.4 ms a step.
- **A desync found and fixed** (multiplayer-chaos-determinism, arena, host vs every restored guest from tick 392): the
  births' tables were made before simUnitWkReserve, which may make the worker records' columns anew; the births then
  initialised records in the freed arrays, and a restored peer's (smaller pool) new healers carried a collector's
  memory. The tables are made after every reserve now.
- **The unit object's own fields** (sim_unit_state.js _simSlotDesc): defined not enumerable, said so; a field a
  JavaScript path had set first stayed enumerable when redefined, and the snapshot encoder (which lists an object's
  own fields) gave one peer's unit a field more than another's (multiplayer-patch, crossroads).
- **Tests**: new spawn-births-columns (every spawner type's birth = the constructor, column by column) and
  spawn-rally; worker-take-rounds, ws-nearfield-split, worker-completion-publication (the fields' tile labels),
  unit-spawn-columns (its batch half went with the batch), research-menu (the page's gone records are a ring now:
  pre-existing failure), chaos tools counting births; spawner-queue-performance deleted (it tested the removed JS
  scheduler; the kernel's order: spawner-production-pass). Full functional run (tests/test-runs/full/
  2026-11-13T09-26-17-911Z, fuzzers 15 / 10 min): 594 / 597, the three failures fixed during the run and passing
  since in both modes; multiplayer-chaos-determinism on six maps with 4 host helpers and without.
- **Measured** (30 steps, two runs; ~5% run-to-run spread): step p50 151.5 / 144.9 ms, mean 156.4 / 149.1 (start of
  the day: ~151 / 154). Within the noise: the helpers are saturated (background lanes ~550 ms of helper CPU a step),
  so time freed on the simulation thread goes to the background chunks it takes at its waits (~17 ms a step).
- **Where the time is now** (fin2 run): foreground walls a step: 89 MOVE_OCCUPANCY 35.9, 8 MOVE 12.5, 32 ACQ_SNAP 4.5,
  131 WAI_DECIDE 3.1, 151 FLOW_PENDING 3.0, 30 VIS_SNAP 2.9, 184 UNIT_GONE 2.8, 24 STATUS 2.7; background helper CPU
  a step: 152 flow-look exact 108, 33 acquisition scan 63, 135 nav build 60, 39 worker-search scan 47, 28 visibility
  seed 41, 98 acquisition answers 25, 62 combat brain 24, 136 return spawners 21. Next: less background work (the
  flow looks' bursts, the acquisition kernels ~130 ms together), then the collectors' group rebuild at each post
  (~1.8 ms of serial kernels: candidates, group, buckets).
