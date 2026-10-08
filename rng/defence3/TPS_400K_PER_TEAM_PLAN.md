# 400k units per team: implementation stages, benchmarks, results

Working log for `400K_OPTIMIZATION_PLAN.md` (the plan). Target: 800,000 live
units (400k per team) at 20 TPS on the Ryzen 7 4800H / 16 GB laptop: mean
complete tick ≤ 40 ms, p99 < 50 ms. Update this file at the end of every
work session: what changed, what was measured, rejected experiments, next.

## Benchmark manifests

Never run two benchmarks at once (the 800k world takes ~6.5 GB RSS of the
16 GB; free memory drops below 0.5 GB during a run).

| Name | Command | Notes |
|---|---|---|
| B800 (primary) | `env DATA=tests/400000-1000.json HELPERS=7 TOPPHASES=1 UPDSPLIT=1 KTIME=1 STATES=1 ACTIVE=1 BATTLE=mix MEMSTAT=1 node --max-old-space-size=12000 .claude/tickbench.cjs 5` | 400k per team (693k slots at start, ~650k live in the timed window), economy + combat, full visibility; 100 timed ticks (~80 s wall + ~4 min setup). Includes the harness's mass move order (every combat unit of both teams to 10 rally points) at tick ~200: the "repeated large orders" workload. |
| KCPU800 | `env DATA=tests/400000-1000.json ACTIVE=1 BATTLE=mix KCPU=1 TOPPHASES=1 node --max-old-space-size=12000 .claude/tickbench.cjs 2` | No helpers: every kernel runs on the simulation thread, so `kcpu` is each kernel's whole CPU per tick. |
| B400 (quick) | as B800 with `DATA=tests/200000-1000.json` and `3` seconds | 200k per team; for diagnosis probes (2-3 min). |
| Probes | `EVAL="$(cat .claude/probes/move_why.js)" AFTER='JSON.stringify(__scratch.mw)'`, `WAKESTAT=1`, `.claude/probes/slow_updates.js`, `PROFILE_RANGE=130,160 PROFILE_OUT=...` | see OPTIMIZATION_PROGRESS.md "How to verify and measure" |
| Kernel replay | `.claude/kdump.js` (EVALALL + DUMPBIN, guest's calls of one tick) then `node .claude/wbench.cjs <dir> SIM_KERNEL_X` | one thread, JS vs wasm, outputs compared |

Visibility modes (team, team + history) and Edge rendering runs are still to
be added to the matrix (plan §5).

## Stage status

| Stage | Work | Status |
|---|---|---|
| 0 | Rebaseline at 400k per team; reconcile timers; kernel CPU | done (2026-10-08): B800 and KCPU800 below |
| 1 | Compact state, remove object execution (unit pass) | started: floor hand-back, mvPF column (below) |
| 2 | Movement motor, spatial runs, separation | measured (MOVE and separation splits below); division-free tick tests in MOVE |
| 3 | Shared queries, navigation, hashing | navigation rebuild spikes cut (re-route stagger, bulk lane cap, heap clears, batching) |
| 4 | Visibility, lasers, statuses, hits, adjacency, workers | — |

## Stage 0 baseline (HEAD 83e3a03, 2026-10-08)

B800, `.claude/s0-800k-a.log`: mean **131.6 ms**, p50 109.4, p95 307.0, max
441.7; 652,662 live units at the end; 0 desyncs, 0 patches. RSS 6.6 GB at the
start (two peers in one process), wasm heaps 2318 + 1628 MB.

Main thread, mean ms per tick (TOPPHASES, exclusive top-level phases):

| Phase | ms |
|---|---:|
| unit pass (`_forEachUnitInTickOrder`) | 24.9 |
| `simMoveRun` (MOVE kernel wall 14.0) | 19.5 |
| separation (FINISH wall 5.8 + wait + commit) | 14.0 |
| state hash (`resyncAfterTick`) | 10.2 |
| effective stats | 6.2 |
| status prepass | 4.8 |
| navigation tick | 3.4 |
| visibility | 3.1 |
| orders, nav fields flush | 2.8 + 2.8 |
| hits, lasers, state collect, stats | 2.2 + 2.0 + 1.8 + 1.8 |

Unit pass by state (UPDSPLIT, ms / calls per tick): moving combat units
(`c1`) 14.5 / 3124, worker MOVING_TO 7.6 / 228, RETURNING_FOR_GOLD 4.0 / 462,
idle researchers 3.0 / 1903, idle builders 2.8 / 647, attack-movers 2.0 / 498.

Spikes: the worst ticks (270-440 ms) follow the mass move order: tick 201
`navTick` 328 ms (a navigation rebuild's collect, helpers busy with the order),
202 `simMoveRun` 109 + separation 60, 203 `spatialIndexRebuild` 112, 213/215
unit pass 162 ms (arrivals / pending paths en masse).

### Why moving units still ran Unit.update (move_why probe)

800k: armed movers handed back on a tile with a hostile structure
(`hostilefloor`) were ~60% of the moving units' fallbacks; then attack-movers
waiting for a pending path target (not armed: `simMoveTryParkWait` needs an
A* budget retry tick), then frozen units.

## Session log

### 2026-10-08 — Stage 0, first unit-pass and separation work

- **Floor hand-back limited to traps** (kept). The movement kernels (JS
  `_simStepParked`, `_simStepFlow`, `_simMovePre`; Rust `mv.rs` twins via
  `floor_acts`) handed a unit back to `Unit.update` whenever its new tile held
  any structure hostile to it. `Unit.update`'s floor check only acts on
  hostile trap items (lava, poison, ice, water, sand, mine); `mv.scls` class
  2 marks exactly those tiles (also while under construction, so a trap
  finished mid-pass is still handed back). Result at 200k/team: moving
  combat units in `Unit.update` 436 → 154 calls a tick (5.5 → 2.2 ms),
  mean 79.0 → 76.0, 0 desyncs. No rules change: the kernel still decides as
  `Unit.update` would.
- **Separation measurement** (dump of the pair stage at an 800k battle tick,
  `.claude/kdump.js`): 674k entries, 329k units taking part, 443k moved;
  candidates scanned per participant mean 24.8 (p50 18, p90 54, p99 107),
  8.2M in all; 487k contacts (1.48 per participant, 92% same owner); cell
  occupancy: 40% of participants alone in their cell. One-thread replay:
  SEP_PAIRS 74.3 ms, PACK 15.7, MARK 9.9, FINISH 31.1 (wasm). Pair kernel
  split (variants): per-participant setup ~19 ms, SIMD candidate scan ~29 ms,
  exact tests and sums ~24 ms.
- **Rejected: entry-ordered pair sums + scatter.** Summing pushes by entry
  (cell order) and a scatter stage into the slots: pairs 74.3 → 72.3 ms, but
  the scatter costs 10.9 ms (the same random slot writes, moved). Reverted.
- Estimated per-cell batching of participants (exact results): row-run
  setups −41%, candidates +33%; worth ~20-30%, not the 3× the plan wants.
  The 3× needs the plan's rules change (candidate quotas, directed Jacobi,
  density pressure) with the crowd quality gates.

- **Floor fix at 800k** (B800, `.claude/s1-800k-floor.log`): mean 131.6 →
  124.9, p50 109.4 → 104.2, 0 desyncs. Steady state (3 s run, before the
  navigation rebuild, `.claude/s1-lanewait-800k.log`): unit pass 24.9 → 16.1.
- **Main thread does not wait for the lanes** (probe
  `.claude/probes/lane_waits.js`, 800k): background-lane waits ~0.02 ms a
  tick. The helpers have slack; the simulation thread's own serial work and
  the foreground kernels' walls are the critical path (~35 ms of foreground
  kernel wall, ~66 ms of serial JS at 800k in the steady state).
- **Kernel CPU at 800k** (KCPU800, `.claude/s1-kcpu-800k.log`, 472 ms a tick
  in kernels): MOVE 74.6, SEP_PAIRS 71.8, WS_SCAN 48.0, ACQ_SCAN 45.7, the
  unit index (INDEX_MERGE 31.4 as one serial job, FILL 17.4, KEYS 15.3, RUNS
  8.9, TILE_OWNERS 8.3: ~81), SEPARATION_FINISH 29.7, SEP_PACK 15.8, STATUS
  13.0, VIS_SEED 12.8, SP_COUNTS 12.1, SEP_MARK 9.2.
- **The spikes are one navigation rebuild cycle** (not the harness's
  orders): at 200k/team the steady state is 41-60 ms a tick (ticks 195-210),
  then tick 201 `_navNextStage` 75-79 ms serial (49.5 of it the zero-filled
  allocation of the next build's field pools, 11.6 batching every live
  field, 8.7 binding the build), 202-203 foreground kernels and the index
  chain starved while the helpers remake every live field, 211-215 after the
  install 2-4k moving units a tick handed back (flow look: their row says no
  way, 255: the rebuild walled their destinations off; each re-routes once:
  path dropped, substitute search, pending target), 25-90 ms unit passes.
  At 800k the same: 240 ms `navTick`, 160 ms unit passes.
- **Big wasm-heap allocations zeroed in parallel** (kept):
  `simParallelZeroHeap` (sim_parallel.js, kernel `SIM_KERNEL_ZERO`, 53): the
  heap allocator's `fill(0)` of 8 MB and more runs as a foreground job of
  1 MB chunks over a view of the whole heap (bound again only when the heap
  grows), the caller's kernel parameters kept. Rebuild start at 200k/team:
  `simHeapArrayAuto` 49-104 → 26 ms, worst tick 216-225 → 149 ms.
  (Tried first: keeping the pools an install lets go as zeroed spares: no
  allocation at all, but ~170-200 MB more fields kept per peer for good, and
  the match's first rebuild has none. Dropped for the parallel zeroing.)
- **Separation commit lists fewer units** (kept): `pathIsFallbackAstar` and
  `_pendingPathTarget` are prototype accessors (values in `_pfa` / `_ppt`,
  like `path` / `targetBuilding`) that keep the `mvPF` column (1 while both
  are set). SEPARATION_FINISH (JS and Rust, `?unit.mvPF` optional) lists a
  unit on its path-retry tick only with that bit; before, every unit with
  contacts on its retry tick was listed and its object read on the
  simulation thread (~50k a tick at 800k) to find the few retrying.
- Tests: wasm-kernels, shared-unit-state, storage-abi,
  shared-separation-commit pass. kernel-object-equivalence,
  separation-pairs and unit-hidden-class fail the same way on HEAD
  (checked in a HEAD worktree): equivalence was given up with the combat
  brain (BRAIN_OFF_MAIN_THREAD_PLAN.md).

- **Determinism suite** (run-regressions, both modes): the same 11 failures
  on HEAD and with this session's changes (corruption-fuzz flips between
  modes: flaky). On HEAD already: chaos-determinism (nondeterministic
  divergence at tick 455, solar_system), patch (live joiners disagree),
  cross-engine (mode 0), desync-recovery (repair 4.5 s), host-migration
  (mode 1), shared-spatial-determinism, kernel-object equivalence. Likely
  cause to check first: a restore disarms every unit on the restoring peer
  only, so it runs Unit.update where the others run the kernels, which no
  longer decide alike since the combat brain. **Must be fixed before the
  acceptance gate** (multiplayer is the real mode).
- **Navigation rebuild spikes** (all kept; SIM_RULES_REVISION 2 → 3 for the
  first two):
  - Units whose flow look finds no way (row 255 after an install walled off
    their destination) stand and go to Unit.update on their own tick of
    SIM_REROUTE_TICKS = 16 (JS `_simMoveFlow`, Rust `move_flow`), not all on
    one tick: one rally group (~47k units at 800k) re-routes over 0.8 s.
  - Bulk lane cap: at most helpers - 3 helpers inside SIM_LANE_NAVX chunks
    (`SIM_PAR_BG_CAP` / `SIM_PAR_BG_RUN` control words; helper loop), so the
    foreground kernels keep helpers while every live field is remade. 800k
    tick 202: 319 → 80-102 ms.
  - Heap allocations: memory above the heap's high-water mark (never used
    since it grew) is not cleared (`_simHeap.hw`, `fresh`); big clears run
    in parallel over `_simWasmMem.buffer` (no binding: helpers busy elsewhere
    had not taken a fresh binding and left the whole clear to the
    simulation thread); the next build's field pool and rows are not cleared
    at all (`simHeapArrayAuto(..., clear false)`: a slot is written whole
    before it is marked made). A 300 MB clear alone is 117-150 ms on one
    thread here.
  - `_navFieldsBatch` (next build): rows grouped by one numeric sort, not a
    map lookup per slot (33 → 26 ms at 800k; the rest is the rowSrc map).
  - Movement kernels: `(t + id) % ticks` tests without a division in most
    calls (`irem_f` / `rem64_f` in mv.rs: masks for powers of two, constant
    divisors for 10/20/30): MOVE one-thread replay 82.8 → 73.5 ms, outputs
    unchanged.
- **B800 after these** (`.claude/s1-800k-g.log`, before the uncleared pools):
  mean 131.6 → **110.0**, p50 109.4 → 104.5, p95 307 → **158.7**, max 442 →
  236, steady state (ticks 150-200) ~88 ms, 0 desyncs. Tick 201 (rebuild
  start) 206 ms: field pool allocation 61, batching 26, binding 9.

- **Session end B800** (`.claude/s2-800k-final.log`): mean 131.6 → **110.3**,
  p50 109.4 → **103.9**, p95 307.0 → **167.3**, max 441.7 → **224.7**, 0
  desyncs; steady state (ticks 150-200) ~88 ms. The worst ticks are now the
  battle setup's (116-121), then the rebuild start (201: 171 ms).
- **MOVE split** (one-thread replay of an 800k battle tick, ~83 ms before the
  division fix): step pass ~31, pre ~9, flow/path steering ~27, epilogue ~15.
  The JS and Rust twins disagree on two slots' steer commit (mvCN / mvCT) in
  that replay: production runs Rust everywhere, but the twin rule is broken.
- **Untimed steady-state work** (SUBPHASES, 800k): workerSearchTierStep 6.8 ms,
  simUnitStateCollect 3.5 (detaching the tick's dead), `_acqTierStep` 2.3,
  towersTick 2.2, adjacencyLaneStep 2.0, laserBeamsTick 1.9; a laser-sound
  loop over every tower each tick (presentation in the simulation).

### 2026-10-08 (cont.) — every simulation kernel in Rust, JS bodies removed

Directive: no JS kernels; the Rust kernels need not match the old JS bit for
bit, only be deterministic, and should be as fast as Rust/SIMD allows (no JS
emulation). Determinism-suite fixes come after the optimization work.

- New `wasm/src/k.rs`, generic convention: JS `_simRust(K, P, chunk, fn,
  name)` writes the array addresses of `_simWK([...])` into argument words
  512.., the thread's scratch at words 1000/1001, P as f64 at byte 4096;
  Rust `K::new(a)`, `k.p::<T>(i)`, `k.f(i)`, `k.i(i)`, `job(chunk, per, n)`.
  A kernel that cannot run (no module, an array outside the heap) throws
  (`_simNoWasm`); helper errors are flagged (SIM_PAR_ERR), not hung on.
  `simSharedArray` is heap-backed once the heap is up. An optional array
  bound empty counts as unbound (`_navNoCost`).
- Ported this session (JS bodies deleted): WS_SELECT / WS_SCAN / WS_ORDER
  (worker search; area BFS stamps in the scratch, tag TAG_WS), HEAL_CAND /
  HEAL_REDUCE, UPKEEP, SAT_ROWS / SAT_COLS (SIMD column sums), the radix order
  (SPATIAL_HISTOGRAM / PREFIX / SCATTER), AREA_BOX, ZERO, LASER_HITS,
  EFF_COUNT, ADJ_FLOOD (its stamps in a bound `adj.wk`), NAV_COST / NODES /
  PARTS / GRAPH / SUBST, VISIBILITY (spans computed in the source pass, the
  area spread as a level-ordered multi-source BFS: each area queued once,
  fixed scratch; `vis.wk` per job only when a map outgrows the scratch).
  Earlier: INDEX_*, TILE_OWNERS, SP_COUNTS, STATUS, HELD_DEAD, UPD_CAND,
  UNIT_RETIRE, ACQ_*, COMBAT_*, EFF_UNITS, HITS, VIS_SNAP/SEED/SPREAD,
  COMBAT_BRAIN, NAV_FIELDS / NAV_LOCAL (nav_field), SEPARATION_* chain.
- **Left in JS: UNIT_FRAME** (presentation): its output is the frame
  SharedArrayBuffer posted to the page / presentation worker, which wasm
  cannot write; moving it means frames inside the wasm memory (views with a
  base offset, the trailer-token pool, sim_presentation.js) — a protocol
  change, not a kernel port.
- Tests adapted: shared-spatial-order (loads the wasm runtime, keys in the
  heap), collector-farms / worker-target-index (stub `simHeapArrayAuto`).
  Passing: worker-walk, research-queue, collector-farms, worker-target-index,
  spatial-index-builds, shared-spatial-order, index-merge, pathfinding-routing,
  nav-build-kernels, nav-background, nav-rows, nav-reach, nav-crowd-arrival,
  group-path-limit, path-regions-*, separation-jitter,
  unit-collision-smoothness, shared-unit-state, shared-kernel-threads,
  multiplayer-border-combat, structure-targeting, team-watch-effects,
  adjacency-dirty-set, laser-*, resource-penalty-stats, shrine,
  combat-effects, visibility-* (but one), local-visual-snapshot,
  lod-visible-budget.
- Failing: visibility-history-performance (fails the same at HEAD);
  multiplayer-scenarios E "combat kills units" (HEAD passes by one death:
  the fight there is marginal in both — most of one side idles at home after
  the attack-move; the numbers now differ, 3 deaths instead of 4).
- B400 (`.claude/s4-400k-a.log`, 7 helpers): mean 77.7, p50 72.1, p95 131.5,
  max 171.8, 0 desyncs (HEAD control earlier this session: 88.4 mean).

## Next

0. Optimize the Rust kernels (SIMD, layouts; no JS emulation), then the
   main-thread serial work; then the determinism suite failures (above).
1. Navigation (plan E.4/E.5), for the p99 gate: the rebuild's remaining
   serial start (batching every live field, binding), foreground kernels
   starved by the remake of every live field (smaller background jobs or
   fewer fields remade: only those whose clusters changed), and the burst of
   re-routing after an install.
2. MOVE kernel CPU (74.6 ms at 800k; 14 ms of foreground wall): dump and
   replay (kdump + wbench) to split its passes, then the motor plan (A).
3. Hash (~10 ms serial at 800k), effective-stats apply (~5 ms), separation
   FINISH (30 ms CPU): see the profiles above.
