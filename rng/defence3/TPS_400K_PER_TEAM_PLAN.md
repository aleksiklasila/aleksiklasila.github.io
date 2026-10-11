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
| SEL300 (spikes, in Edge) | `NODE_PATH=<playwright> SECS=12 WARM_S=15 PHASES=idle,selall,box,move,boxmove,groups TAG=<tag> node tests/selection-thrash-bench.cjs 300000-1000.json` | The real page, simulation worker, helpers and GPU, the mouse driven as a player's: nothing selected, everything selected, 5 boxes a second (all / a tenth / nine tenths), a 300k-unit order, boxes over the moving army, control groups. Per phase: frame times and how many frames over 33/50/100/250 ms, tick gaps, the worker's time per tick, long tasks, input handler times, and the page / worker functions with the longest single call (the spikes, not the means). `PROFILE=<phase>` writes CPU profiles of the page and every worker (`.claude/selbench-<tag>-<phase>-*.cpuprofile`; `node .claude/profsum.cjs <file>`). ~4 min. |

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

### 2026-10-09 — main thread: structural batches (target: B800 main ≤ 40-50 ms)

- **Hash cadence** (the requirement is quick detection and resync, not a
  hash every tick): SNAP_HASH_EVERY 2, slices and rotations by the hash's
  index (snapHashDue), the resync's rotation window and wait scaled
  (SNAP_HASH_ROTATION_TICKS; snapHashRotation takes one hash more: a
  request comes at the first hashed tick a rotation after the divergence).
  Building/grid rounds 10 → 5, unit object groups 80 → 40: detection delays
  as before (≤ 100 ticks buildings, 1 s units). Corruption fuzz: every
  corruption repaired (its final bit-exact check fails on the existing
  recurring divergence, as before the change).
- **Kernel-owned waits**: setters (commandState, workerState, pathIndex,
  owner, _workerNextIdleRetargetTick) disarm only on a change; a stats
  change keeps a parked unit unless its park uses stats (mvFlags 1/2/16); a
  worker on its cooldown parks whatever its command; units waiting for their
  way (pending target, no path) park in the kernel with an arrival check
  (mvFlags 8, mvTgX/Y/Tol). Idle researchers (~440 updates a tick at 400k)
  no longer run Unit.update.
- **Steady step** (MOVE_STEP): a committed step's window (mvSteady: steer
  end, look ticks without the brain, floor look, worker check) checked four
  slots at a time; half-up quantization as the scalar step (same results);
  move_pre / epilogue skip 16 slots at a time. With the combat brain the
  step kernel no longer gates on the old look ticks. MOVE replay 37 → 32 ms.
- **Field generations adopted** in the kernel after a build install (same
  slot and destination, field made): no hand-back.
- **Next-build staging**: one slot per destination per pool, so rows are
  never copied: the sort/dedup and rowSrc lookups dropped, live slots from
  the meta. Tick 201 navTick 52 → 18 ms.
- **Stat rows**: (owner, type, base, effective level) rows (eff.rowOf,
  eff.r*), Unit.preComputed through unit.statRow; EFF_UNITS assigns a new
  level's row and the movement columns (simMoveStatsChanged's keeps and
  disarms) itself, JS only for missing rows / drive-by boxes.
  recalculateUnitEffectiveStats 5.0 → 3.3 ms at 800k.
- ACQ_SCAN row search (rows outward with the best distance's span, one
  entry run per row, SIMD entries): replay 117 → 90 ms, same outputs.
- Re-routes every 32 ticks (SIM_REROUTE_TICKS): an install leaving ~20k
  units without a way spreads over 1.6 s. SIM_RULES_REVISION 4.
- Desyncs on the 10k bench (30, 2 patches): the same at HEAD (33, 3).
- B800 (`.claude/s4-800k-rest.log`): mean 103.7 → 92.5, p50 99.1 → 89.9,
  p95 143.9 → 122.9, max 216 → 184. Steady main: MOVE 15.9, separation
  9.7, unit pass 9.4, hash 5.8, worker tier 4.3, eff 3.2, status 3.2, orders
  2.7, vis 2.6, combat scan 2.5, nav flush 2.4, hits 2.1, laser links 2.1,
  collect 2.0, stats 1.8, acq tier 1.7, adjacency 1.6, lasers 1.4, towers 1.2.

- **Later the same day**: stat rows mirror the JS path exactly (cover sync
  on every new level, a missing drive-by box falls back to JS); an
  attack-mover's park keeps its aggro reach through stats changes; fallback
  A* waiters park too (their upgrades are the pending resolver's); the
  builder watchdog samples in the kernel (wkWx/wkWy/wkLmt columns behind
  Unit._builderLastWatchX/Y/_builderLastMoveTick, mvFlags 4); workers on
  their way back for material and salvagers' returns are worker kind 3 (no
  check ticks); simUnitStateCollect reads the typed dead column; worker
  search takes at most WS_TAKE_MAX (384) a tick. Hash: 20 slices every tick
  (an even share; every other tick doubled the hashed ticks: 13-33 ms).
  B800 (`.claude/s4-800k-e.log`, before the last two): mean 92.3, p50 88.7,
  p95 121.4; unit pass 9.4 → 6.2, collect 2.0 → 1.0.
- **Known broken (determinism, deferred)**: multiplayer-snapshot "restored
  peers evolve differently" and a corruption-fuzz unitGone repair: the
  kernel-owned waits (route-wait parks, kept parks, steady windows, the
  watchdog) hold state the snapshot does not carry, so a restored peer runs
  Unit.update where the original keeps units parked. Fix with the
  determinism pass: snapshot the movement columns (mvOn, mvFlags, mvWake,
  mvTg*, mvSteady, steer state) or make every park recomputable (no cached
  tolerances: compute the arrival tolerance in the kernel from mvSpd and
  statuses).

### 2026-10-09 (later) — state hash: every unit field from columns (plan C)

- **Units hashed from columns only.** The hashed object fields (targets,
  hold/forced flags, attack-move goal, worker target/type/carry/reservation/
  materials, budget retry, scout target, watcher team: SIM_UNIT_OBJ_FIELDS)
  live in per-slot arrays beside the typed columns (columns.oc_<field>, a
  detached unit's in its _det); every set that changes a value moves the
  slot's digest (unit.hObj) by its term change, as do the accessors of the
  structure target, pending way, fallback flag, worker state and its idle
  search (SIM_HASH_DIGEST_FIELDS). Restores set every field through the
  same setters, so the digest equals simUnitHashDigest(u) (checked on every
  unit). Not in the digest: unitType (a plain field again: its accessor cost
  ~50 ns a read) and path (set on every re-route; positions, velocity and
  pathIndex show where it leads).
- **k_snap_units** (SIM_KERNEL_SNAP_REGION, k.rs): 22 columns + digest +
  id seed, four units a lane (i32x4 mix: (key ^ word) * M; NaN one word);
  slices are blocks of the units list (units listed together hold slots
  together: consecutive slots are one v128 load per column), 2048 positions
  a job; regions per lane in f32x4. **k_snap_merge** (one job, on the main
  thread): the jobs' (region, hash) lists into the region sums the
  structures left (snap.racc/rstamp/rlist, heap), every region as a pair,
  the sum. Pairs are a Uint32Array (rotations go out as plain arrays). The
  JS object hashers, rotation groups and per-job JS merging are gone.
- **Structures**: core fields every second are owner, energy and
  construction (mines: resources); levels, stacks, timers and statuses in
  the 20 s full round; reservations and the structure lists' order also in
  that round (their lengths every slice).
- Pitfalls found: simUnitStateCompact must carry the object arrays (it
  built empty ones: restored hosts read undefined targets, and sparse writes
  turned the arrays into dictionary mode: 300 ms ticks at 400k); arrays are
  preallocated packed at the slot capacity. A path-digest WeakMap made the
  mass order's full GC slow.
- **V8 memory reducer**: a "Mark-Compact (reduce)" after the mass order
  (tick 212) pauses 0.3-0.8 s at 800k (two peers, ~3 GB heap, 16 GB
  machine); gone with --no-memory-reducer (max 184 ms). A heuristic full GC,
  not this change's, but a hitch a browser can hit too: fewer JS objects
  (more state in typed columns) is the lasting fix.
- B800 (`.claude/s5-800k-e.log`, --no-memory-reducer): mean 90.9, p50 85.5,
  p95 135.9, max 184, 0 desyncs. Hash 3.85 ms a tick (was 8.0): structures
  3.0 (cold JS objects: ~4k a tick), merge 0.19, globals 0.16, units kernel
  wait 0.02. MOVE 17.4, unit pass 10.8, separation 10.4, orders 3.9,
  status 3.5, eff 3.4, vis 3.3, nav flush 2.6.
- Tests: desync recovery unit/player/building repaired (mine: detected
  when its slice comes, 0.8 s, then 1.2 s to patch: over the test's 1.5 s
  with 20 slices); the patch test's restored-guest shrine difference and the
  snapshot test's positions 4 ticks after a restore are the known
  kernel-state gaps (object fields restore identically).

### 2026-10-09 (later) — MOVE fused: one visit per unit (separation finish, combat, push)

- **Separation finish fused into MOVE** (SIM_RULES_REVISION 5): the pair
  kernel's pushes (prebuilt after the last tick, waited for before MOVE:
  ~0 ms) are applied where each unit moved, in the movement kernel; the
  SEPARATION_FINISH kernel, its JS commit pass and
  tests/shared-separation-commit.test.cjs are gone. Pair sums are Int32
  (px/py), one heap block (sep.sums, views by simHeapView) zeroed by the
  chain's first stage (k_zero) instead of in MOVE.
- **MOVE in 4-slot groups** (mv_move): step4 (steady flow) and the new
  combat4 (brain hold / chase in f32x4, target checks by gather) four a
  lane; the rest scalar per lane; then push4 (scale, clamp, now/carry,
  quantize, tile test, sepMov, retry filter in f32x4) and the epilogue only
  for lanes with something left (epi_slot). Blocked pushes are swept in the
  kernel against the unit's profile walls (applyUnitSeparation's rule); JS
  only for a unit left on a blocked tile. A scalar flow step reopens its
  steady window (61k of 193k flow lanes per tick had fallen off the vector
  step for the rest of their committed step).
- Replay (B400 tick, one thread; `.claude/rbench.cjs` with PSET / DBGC
  switches for deletion and counters): MOVE 30 + finish 13.5 → MOVE 38-40.
  Split: vector paths + scalar loop ~8, push ~9 (memory: sums written by
  other threads), epilogue small, steering looks (move_flow / flow_look)
  ~12.6 (21.6k looks, ~580 ns each). A per-chunk look cache hit 2.5%:
  dropped.
- Crowd tests pass (separation-jitter, unit-collision-smoothness 1.48%,
  nav-crowd-arrival); the small bench's divergence is the pre-existing one
  (players + list membership, now from tick 223).
- B400: mean 61.3 (was ~66). B800 (`.claude/s5-800k-i.log`,
  --no-memory-reducer): mean 88.6, p50 84.0, p95 117.8, max 213 (battle
  setup), 0 desyncs; steady ticks ~74 ms; MOVE kernel 15.5 ms foreground.
- Where MOVE's time is: ~130 ms CPU per tick at 800k (~165 ns a unit,
  1.6x the single-thread replay: memory contention). It touches ~170 bytes
  per unit per tick (13 columns for the steady step alone, read-modify-
  write stores, sums from other threads). Next: data reduction (plan 2):
  i32 1/8-px positions or at least narrower motor state (i16 steps and
  carries, one tile/steady word), stores only of changed values, the
  remaining scalar lanes (parked units, steering looks) vectorized or
  made rarer, and the pair kernel (32 ms a tick at 400k, one thread) as
  plan B's 4x4 contact tiles.

### 2026-10-09 (later) — main-thread JS long tail, first groups

Section timers in the tick body (B800 steady) found: dead-unit compaction
+ collection 6.6 ms, the laser buzzer loop over every tower 3.0, the pushed
units' JS (sweeps, path retries) 5.3, the field sweep over unit paths 2.6,
the worker tier's takes 5.5 (~1,030 a tick, mostly surplus researchers
failing for the same labs every 20 ticks), laser links over every tower on
any structure change 2.1, game stats over unit objects 2.1, charge sums
over chunk x player x type 1.6.

- Dead units leave the units list by swap-remove (O(1) each; the list's
  order changes deterministically).
- The laser sound walks the laser towers (listed every second); laser links
  from a laser-tower list kept by laserTowersVersion.
- A unit left on a blocked tile after its push steps toward the nearest open
  neighbouring tile in the kernel (half a tile a tick); no push-triggered
  path retries (the pending-path schedule's alone).
- Field sweep from columns: rtEnd/nvProf (Unit._routeEnd's accessor), the
  path setter's nvPK, _routeKey a per-slot field.
- Charge sums only for the chunks flagged as charged.
- Game stats from columns (wkIdle kept by the workerState setter);
  workerType is a per-slot field whose setter keeps isWk (it was set at the
  slot's start only, before the type: every worker read as not one).
- Worker search backoff: a take that found nothing it could have doubles
  the worker's search period (20 → 160 ticks at most; wsFail column,
  k_ws_select).
- B800 (`.claude/s6-800k-b.log`): mean 88.6 → 71.7, p50 84.0 → 67.1, p95
  117.8 → 103.5, steady ticks ~74 → 57.8, 0 desyncs.

### 2026-10-09 (later) — hits off the serial path, status DoT in the kernel

- Hits on units: no sort, no per-hit main-thread loop. SIM_KERNEL_HITS
  (k.rs k_hits) takes the queued JS attacks (hit.q/dmg/sty/wk) and the
  MOVE kernel's per-chunk attack lists in place; each hit goes into its
  target's sums by atomics (unit.hAcc damage in 1/16ths: an integer sum,
  any order; hSty status bits, hBurnD/hPoiD the largest tick damage;
  hWatchK the longest scout watch, then the highest attacker id). Targets
  are listed at their first hit (hTouch, hit.tlist). SIM_KERNEL_HITS_APPLY
  (66) applies the sums: energy, statuses by max, the watch (wTeam), fallen,
  the shrine share per job (fixed point), units newly watched (hit.wlist:
  vision cover on the main thread).
- Gameplay changes: hits are no longer ranked by attacker id (sums are
  order-free); statuses by max; no object retaliation (the combat brain
  already made it a no-op); the looks are capped at SIM_HITS_PRESENT
  (512), and which hits get them may differ between peers (presentation
  only).
- watchedByTeam is a typed column (unit.wTeam, Int8, -1 none) behind an
  accessor, hashed in k_snap_units (word 34). The scout watch duration
  comes from the precomputed stats (preComputed.watchDuration, in ticks):
  the atkWatch column, set with atkDmg/atkSty.
- Status DoT: the status kernel credits the shrines (st.shr per job, fixed
  point) and lists only watch ends plus STATUS_LOOKS_PER_JOB damage looks
  a job; no main-thread shrineDamageTaken per DoT event.
- Structure hits and hits on units without columns are still on the main
  thread, in queue order.
- B800 (`.claude/s7-800k-hits.log`): mean 71.8, p50 68.4, p95 115.9, 0
  desyncs; steady (tick ≥ 150) gameTick mean 62.1 / p50 56.6. Hits 1.7 ms,
  status 2.5 ms (was 3.3). Biggest steady phases: simMoveRun 19.0, unit
  pass (excl. MOVE) ~9, hash 3.3, orders 3.2, effective stats 3.2,
  visibility 2.5.
- The small bench now shows 7-16 desync detections from tick 260 (players
  and builder regions). The count varies run to run, and was 0 once with
  a probe attached, so it is timing-dependent. Deferred, by the user's
  ordering: main thread first, determinism fixes after. Probes for it:
  `.claude/probes/diff_codes.js` (per-tick hash diff between peers, via
  tickbench's shared `__scratch.x`) and `peer_fields.js` (field diffs of
  chosen units and the players).

### 2026-10-09 (evening) — int positions, vector paths, waits removed, traps in the kernel

Baseline this session (`.claude/s8-800k-base.log`): B800 mean 77.9, steady
(tick >= 150) gameTick 66.7; every 4th tick ~82 (a 17-20 ms wait).

- **Unit positions are Int32 eighths of a pixel** (x, y, prevX, prevY, x0,
  y0, vt.x/y; SIM_RULES_REVISION 6). Accessors read/write pixels (a store
  rounds to the eighth, halves up: what every move already quantized to);
  Rust: `Q8` scalar (lib.rs) for cold code, integer SIMD in the hot paths
  (step4, combat4, push4: steps added as whole eighths, tiles by a shift,
  mv.rs tile4/q8x4). The frame kernel and the presentation worker scale
  (snapshots are Int32 copies). Alone: MOVE wall unchanged (17.2 -> 17.9,
  noise): the step arithmetic was not the cost.
- **MOVE vector paths**: park4 (parked units, ~54k lanes/tick at B400) and
  idle4 (unarmed/dead slots) four a lane; step4's byte stores and the field
  check once per group when four lanes share a field; done lanes' fire bytes
  cleared four at once; sepMov written by the vector paths (push4 loads no
  position unless a push applies). Shared flow-look cache (mv.lookc, 2^18
  seqlocked entries keyed by tile, destination, kind, profile, build, wall
  version: misses 21.5k -> 1.5k/tick at B400; cleared at navReset / wall
  rebuild). Replay counters: `cargo build --features dbgc` (mv.rs dbgc!,
  words 1536.. of the argument block; rbench DBGC=1); `--features prof`
  keeps the passes as functions for profiles (rbench + --cpu-prof).
  MOVE replay split (B400 battle tick, one thread, ~37 ms): step4 14.5%,
  push4 11.8%, move_flow + flow_look ~21%, combat4 8%, epilogue 7.8%.
- **wasm-opt -O3** (binaryen version_133 in gitignored wasm/tools/, found by
  build.cjs; README): MOVE replay -3..6%, same outputs.
- **Main-thread waits removed**: the acquisition chain copies the live
  index (ranges, stamps, owners, entry slots) into its own arrays in its
  first stage; the index prebuild waits for that stage only (was 17-20 ms
  every 4th tick). The units' cover seeds and spread are one chain (the
  phase-2 post waited for the seeds).
- **Parallel index merge** (k.rs k_ixm_*: inverse, per-band keep, per-block
  changed lists, plan, per-band merge): the merge was one serial job of
  ~109 ms CPU at 800k (deaths' swap-removes reorder unit indices, so the
  kept entries were out of order and everything was heapsorted). Same
  order as before (tests/index-merge).
- **Vectorized slot kernels**: k_status by slot (bulk copies, 16-slot skip
  of slots with nothing running; its list holds slots), k_acq_snap (bulk
  copies + SIMD flags), k_combat_scan (4-lane prefilter).
- **Floor traps in the movement kernel** (mv.rs floor_hit): per tile the
  trap's kind and level (mv.trapK/trapL), its strength per owner, kind and
  level a mirror of PRECOMPUTED_STATS_MAP_PLAYER (mv.trapT/TG, rebuilt for an
  owner when its building stats are rebuilt), unit resistances by type
  (mv.tres). Movers on hostile traps no longer go to Unit.update (mines
  still do). tests/floor-trap-kernel.test.cjs.
- **Building research staggered**: research rebuilds the owner's tables
  (in place: buildings reference the entries); derived per-building values
  catch up in buildingResearchSweep (a TICK_RATE-th of the lists a tick, by
  the owner's bResVer / the building's _bResVer, both in snapshots).
- **Bug found**: lane-params poisoning between the adjacency post and the
  units' cover chain (shared lane T5): the adjacency wrote the lane's params
  before its post waited for the lane, so the guest's pending cover stages
  ran with them (89 desyncs at B400). simParallelStageParams now finishes a
  pending job on its lane first; the adjacency post waits before writing.
- Rejected: chaining the worker search's scan and ordering (the scan reads
  the collector groups in place, which the unit pass changes: keeps its
  phase wait). A per-second trap-table sweep (re-resolved stats for every
  trap tile from inside _simMoveStructs: 118 ms ticks).
- Lost and recovered: a patch script truncated mv.rs / unit.js; restored
  from the git index (`git show :path`).
- B800 after the first batches (`.claude/s8-800k-b3c.log`): mean 73.6, p95
  109, steady 61.6, 0 desyncs. B400 at the end (`.claude/s8-400k-bis2.log`):
  mean 54.2, steady 45.1, 0 desyncs.

Remaining main thread at B800 (b3c, steady ms): MOVE kernel 17.9 (+3.5 JS),
unit pass 8 (worker arrivals ~2.2: return-route search on the main thread;
handed-back movers 1.5; push-outs 0.6), orders 3.8 (~1 us/unit of setters),
hash 3.8 (structures' cold objects ~2), effective stats 3.6 (vision
re-registration ~25% of it), visibility 3.0, worker search 2.9 (phase wait),
status 2.1, SP_COUNTS 1.7, adjacency 1.6, hits 1.6, lasers 1.5, collect
1.5, towers 1.3 (targets searched on the main thread).

### 2026-10-09 (night) — structure table, MOVE scalar lanes

Measurement note: B800 run-to-run noise is ±2-4 ms on the steady gameTick
(UPDSPLIT/KTIME/SUBPHASES wrappers add ~8 ms: compare runs with the same
flags). A probe of `simParallelStageParams` (`.claude/probes/
stage_param_waits.js`) found no waits on pending lanes: last session's
lane-params fix costs nothing. Baseline this session (TOPPHASES only,
`.claude/s9-800k-spw.log`): steady gameTick 67.0, MOVE 22.7 (kernel ~19.6).

- **Structure table** (SIM_RULES_REVISION 7; data_state.js `_ST`): per tile
  the hash core of the structure on it (kind code, owner, construction,
  energy; a mine's amount) in typed columns, kept by prototype accessors
  (`structTableAccessors`: owner / underConstruction / energy, gold / astar)
  over backing fields (_ow, _uc, _en, _mv); an entity joins at
  setTileEntity / a restore's _snapSetTile (its tile in _stT), leaves at its
  clear; reset with the tile lookup; made at the first join (the page's
  views never join). Floor items and mines are classes now (FloorItem,
  GoldMine, AstarMine; snapshot shells and '~c' names). Snapshot keys map
  the backing fields to the public names (`structTableKeys` via
  simUnitStateKeys): the snapshot format is unchanged. The hash's
  structure core is a sweep of the slice's regions over the table
  (`_snapStaticCoreSweep`, regions skipped by a per-region count), the
  round's full fields from the objects as before. Hash 4.3 → 2.9 ms
  (`.claude/probes/hash_split.js`: core sweep ~1.0 before the region
  counts; the rest the round's full fields + journal ~0.9, merge 0.28,
  reservations 0.22, globals 0.22). tests/structure-table.test.cjs.
- Pre-existing (identical at HEAD, checked in a worktree): a full restore
  into another solo instance differs in the globals hash part and in towers'
  status fields (undefined until set, 0 once restored); structure-targeting
  (`_simHKey`), laser-links (`laserTowersVersion`), worker-walk,
  multiplayer-snapshot, desync-recovery (mine 2 s) fail the same.
- **MOVE lane census** (dbgc build, `.claude/dump-mv800` tick 180 /
  `dump-mv800b` tick 200 B800 dumps, `.claude/probes/kdump_move_only.js`;
  rbench counters 20-33 now explain why flow lanes leave step4): of 401k
  flow candidates, 46.7k had their steady window over, 30.3k stood in
  another tile than their committed step's, 24.5k were stepping into
  another tile. Profile by pass (`--features prof`, **build without
  wasm-opt**: it re-inlines the passes; `CARGO_PROFILE_RELEASE_STRIP=false`
  keeps names): the scalar flow path (move_flow, nav_step, step_flow,
  move_pre, step_slot, commit, flow_look) was ~half of the kernel's CPU.
- **Steady window no longer ends on the unit's second's tick** (that was
  only the floor's once-a-second trap look): step4 takes that look itself
  (lanes on a hostile structure's tile go scalar). Window-over lanes 46.7k
  → 18.1k.
- **step4 takes tile crossings**: a ground lane stepping into an open tile
  (its profile's walls; step_flow's commit without a slide) stays in the
  vector step (24.4k of 24.5k a tick). Vector-done lanes 74.6% → 83.8%.
- **Flow look record packed**: the nine mvNav* columns are one 8-word
  record a slot (`unit.mvNav`, SIM_NAV_STRIDE: T, D, V, W, G, N1, N2,
  far << 1 | open): a steer touches one line. Replay −6%.
  `.claude/dump_navpack.cjs` converts older dumps.
- B800 (`.claude/s9-800k-nav.log`, ticks 150-199): gameTick 58.5, MOVE
  kernel 17.0 (from 19.6), 0 desyncs.
- What is left in MOVE (replay, packed): step4 19%, flow_look 12% (the
  shared look cache: a random 16 MB table, ~2 cold lines a look), move_flow
  10%, push4 10%, epilogue 8%, nav_step 6%. step4 streams ~26 columns (16
  loads, 10 stores) per lane: an AoS steady-step record (steady, ctl, cvx,
  cvy, flow, fgen, dest) is the next candidate.
- step4 stores vx/vy only when a lane's differs (the committed step's after
  its first tick) and d0 only when set: same outputs (replay digest), the
  steady steppers' lines stay clean.
- **Crowd gate**: unit-collision-smoothness reversal rate 1.51% (gate
  1.5%; HEAD 1.49%). Caused by the steady-window change alone (with the
  window ending on the second's tick again the test matches HEAD exactly:
  crossing, packing and store changes are output-neutral there): on that
  tick the scalar commit (f32 x + vx, quantized) took the step, now step4
  (whole eighths) does; trajectories differ slightly. Kept (−28k scalar
  lanes a tick); to be looked at with the crowd tuning.
- Main thread JS (host profile ticks 150-199, `profpeer2.cjs` with SUB=fn
  for a subtree): structure lists' removal was indexOf + splice over tens of
  thousands of spawners per destroyed building: now O(1) swap-removal
  (`structListPush` / `structListRemove`, place in e._li, self-healing
  reindex); destroyBuilding 0.44 ms a tick. The laser list (link
  recompute) is kept in tile order by laser joins/leaves
  (`laserListToggle`: canonical on every peer whatever the towers' order);
  rebuilding it by filtering every tower on each tower change cost ~2 ms.
  The laser hits kernel lists its reporting slots (`lz.list`): no JS pass
  over whole chunks. The worker search's take hand-off is one variable
  (`_wsCur`), not a Map. Flow orders write each route field once
  (`.claude/orderbench.cjs`: 1.18 → 1.12-1.17 µs a unit; the rest is ~20
  setters a unit, spread).
- **Cover registration in the effective-stats kernel**: a stat row carries
  its visibility cover steps (`eff.rVsA`, −2: for the JavaScript); a unit
  given a new row is registered (vsGen/vsR/vsP1/vsP2/vsA) by k.rs
  eff_row_apply from its columns, as _visCoverSyncUnit, instead of being
  handed back to JS (~1.8 ms a tick in the host profile). Checked at B400
  (`.claude/probes/vis_reg_check.js`): 0 of ~380k units differ from
  _visCoverSyncUnit at ticks 160/180/200; 0 desyncs.
- Machine note: the user's Firefox used ~3.3 cores during the later runs
  (51% CPU with no benchmark): whole-tick numbers of those runs are high.
- Pre-existing failures (identical at HEAD): shrine "exact hashes equal",
  multiplayer-scenarios build/stack/research divergence at tick 328,
  pathfinding-routing and visibility-range-collision (`_simHKey` in their
  sandbox), plus the ones listed above.

### 2026-10-10 — determinism and multiplayer bugs (user: fix them now, no perf loss)

Tools: `DIVTRACE=1` (tests/net-harness.cjs) keeps every peer's per-tick
fingerprint of units, players and structures; a failed hash comparison
prints the first differing tick and entities (`DIVTRACE=2` adds the movement
kernel's steering columns). `.claude/netdiag.cjs` (a hosted match with
EXACT / UNITS / KCOLS / ARM / CHG / RES switches), `.claude/snapdiag.cjs`
(restored peers compared per unit and kernel column).

Fixed:
- **Reused unit slots kept their last unit's kernel state** (committed
  steps, steady windows, flags, stat-derived speeds): a new unit in a reused
  slot inherited them, and slot assignment differs between peers (a restore
  above all). simUnitStateAllocate zeroes every column of a reused slot
  (one generated straight-line function; fresh slots are zero already).
  Restored peers now evolve identically (snapdiag: equal hashes 12 ticks on).
- **The movement kernel's path choice depended on slot alignment**: the
  vector passes ran only on full groups of 4 slots, the last partial group
  always scalar; the vector and scalar steps leave different steady
  windows, so the same unit behaved differently on peers with other slot
  layouts (network-profiles "wan" divergence at tick 129: an A* charge).
  The passes now run on every group, missing lanes masked (mv_move, mv_step).
- **Restored units had no effective stat tables** after a mid-match restore
  (preComputed is derived and not sent; `_needsStatsInit` came false from
  the host): "Cannot read properties of null (reading 'speed')" on every
  late joiner, reloaded or restored peer. `unitDerivedStatsRestore`
  (data_dynamic.js) remakes them at decode end from the sent base tables.
- **Field eviction and game-stat samples strided over slots**: which units
  a sweep cycle visited (and so which flow fields it dropped and remade,
  bumping their generations: units adopting a new generation re-steer)
  depended on the slot layout. Both now stride over the units list (synced
  order) through the slot map (navFieldsSweepStep, data_dynamic stats).
- Harness: the emulated simulation worker had no usable wasm (its
  WebAssembly was another realm than its SharedArrayBuffer: `instanceof`
  failed, every kernel threw): worker-mode tests (mode 1, mixed-rally-move)
  could not run. Also atob/btoa there and in main-menu-settings' sandbox
  (the other session's sim_rebase.js needs it).
- Test sandboxes: unit.js's load-time `_simHKey` / `SIM_NAV_STRIDE` and the
  structure-table hooks guarded (structure-targeting, pathfinding-routing,
  visibility-range-collision, drive-by-attack); laser-links expects tile
  order; unit-retirement expects swap-removal (survivors, not their order);
  tier-result-reduction runs the Rust kernels on heap arrays; drive-by-attack
  tests the object path with the combat brain off.
- Render range overlays are off by default (the user): a mode saved before
  is not restored once (RENDER_RANGE_SETTINGS_VER).
- **Units' effective tables travel in snapshots again** ('preComputed',
  'preComputedEffective' among the unit's snapshot accessors): since stat
  rows they were non-enumerable and dropped; a restored unit's tables could
  not be reproduced (computed under the tables of their time, e.g. another
  resource penalty), so patched guests moved at other speeds.
- **The object-field digest (hObj) is made again for every restored unit**
  (it drifted from the fields on in-place patches: hash mismatch every
  rotation afterwards, repeated patches).
- **A resync flush (every peer) clears every arming-only movement column**
  (SIM_MOVE_ARM_COLUMNS: committed steps, steady windows, flow slots, park
  targets, worker kind, pending chunk moves, look records) as a fresh slot
  has them: a parked unit's leftovers from an earlier arming made the host
  move it where a restored guest did not.
- Hash coverage (corruption fuzz): towers' cooldown deadlines and barracks'
  / spawners' spawn timers in the structure table (`_ST.tim`, Tower cd
  setter, spawnTimer accessor) and the per-second core; worker reservations
  as an incremental per-region digest (workerReservedSet) every slice; the
  towers', barracks' and spawners' list order every slice. multiplayer-patch
  passes on every map (one patch per divergence, exact state after).
- Still failing: corruption fuzz cellType / cellOwner (raw grid writes: grid
  rows are hashed one per 400 ticks; covering the 1M-cell grid within the
  fuzz's 6 s would cost ~0.2-0.4 ms a tick) and playerResearch (a research
  completed on one peer: the staggered stat refresh leaves units' derived
  tables behind after the delta patch); desync-recovery "mine: repair took
  2000" (detection in a 40-tick rotation + patch round trip, over the
  test's 1.5 s); worker-walk (a collector ordered onto its own cloud tower
  inside a closed base ring: findNearestWalkable counts the portal tile as
  walkable, the flow finds it unreachable); kernel-object-equivalence
  (given up with the combat brain); performance-regressions /
  render-frame-stability (the 3D renderer, the other session's work).

### 2026-10-10 (later) — restores independent of history, worker-mode multiplayer, GUI

User: finish the multiplayer fixes, then robustness (desync, resync), keep
TPS, optimize, test in game and in the GUI (e.g. "show JSON" froze the game
with many units): stable whatever the players do.

Restores (a restored world must evolve the same whatever the peer ran
before; `.claude/probes/rollback_restore.cjs` restores one snapshot after
0, 1 and 40 ticks ahead on one instance and diffs per phase, columns and
every global (`global_digest.cjs`)):
- `_combatScanTick === gameTime` skipped the rerun tick's combat scan on a
  peer that had run the restored tick (worker restores): reset at the flush
  (combatScanReset), with the group path budgets keyed by gameTime.
- A dropped prebuilt unit index's epoch was reused by the rebuild: chunks
  it had stamped (empty now) looked current with other units' entries.
  The epoch is used up when dropped (chunk.js _spatialIndexCollect).
- Stat tables follow the resource-penalty multipliers they were *built*
  with (rebuilds lag the resources until the tick's flush): now one applied
  multiplier per player and stockpile (`_statAppliedMult`; research rebuilds
  use it too), carried with the seen ones in snapshots (`g.statMult`);
  decode rebuilds to them, into the existing entry objects (units a patch
  does not carry keep live references). SIM_RULES_REVISION 8.
- Whole restores always lay units out from slot 0 (simUnitStateCompact(true)).

Worker mode (the default), multiplayer:
- A mid-match restore on a page whose simulation runs in its worker built
  navigation there (no kernels on such a page): every join, reload or host
  change threw. Skipped on such pages; the worker restores its own.
- The worker's whole-state restore never reported 'started' for its new
  epoch: the page's clock waited for it, the match stopped for good after a
  host migration or hard resync.
- Exact-lockstep debug mode ran on the page, which has no kernels in worker
  mode: matches never ticked. The worker takes them (and hashes every tick).
- Messages travel on an unordered channel: LOBBY_LEAVE overtook the
  leaver's MATCH_ROLE_UPDATE, the host closed the link and waited for the
  leaver forever. A mid-match LOBBY_LEAVE is a resignation by itself. A
  plain exact-lockstep stop notice no longer replaces a detailed one.
- Tests made tick-exact where they compared peers at different ticks
  (shrine, research-queue); multiplayer-snapshot always on the page's own
  simulation (it drives the codec there directly).
- Harness: DIVTRACE in worker mode hooks the worker's gameTick.

Detection: grid cells on a rotation of their own (SNAP_HASH_CELL_ROUNDS 4:
each row every 4 s, ~12k cells a tick at 1000x1000). Corruption fuzz: every
kind detected and repaired, both modes.

GUI (real Edge, playwright; NODE_PATH to a playwright install):
- `tests/ui-longtask-survey.cjs [fixture]`: every control (depth first:
  popups and tabs while open) in a running match; long tasks and gaps
  between tick results. At 200k units (100000-1000.json): 125 controls, all
  gaps under ~165 ms except 3D view switch (334 ms task; renderer3d, the
  other session). "Open JSON" (stats map: 7 MB, 400k lines into a textarea,
  seconds) now shows one entry at a time (~60 ms).
- `tests/browser-mp-gui-fuzz.cjs [fixture]`: a match in real tabs over a
  BroadcastChannel stand-in for PeerJS (tests/browser-fake-peer.js; per-tab
  storage), every control on every player, keys, 2D/3D: 256 controls, 0
  desyncs, 0 hash mismatches, no errors, no stalls.
- The visible tick pump ran from requestAnimationFrame only: frames stopping
  while the tab is not hidden (unfocused/occluded window, a long frame)
  stopped ticks for every player (gaps up to ~1 s in the fuzz). A worker-
  timed watchdog runs the same pump when no frame advanced the tick clock
  for 2.5 ticks (utils_net_quality.js netPumpWatchdog*, multiplayer).

B800 after all of this (`.claude/s11-800k-a.log`): mean 71.56 ms (71.6-72.3
before), 0 desyncs, 0 patches.

Then:
- Orders' unit ids travel compactly (`uidz`, main.js actionIdsEncode /
  actionIdsDecode; decoded by sanitizeAction on every peer, the issuer too;
  bounded against hostile input): a 400k-unit order was 2-3 MB of JSON per
  bundle, sent by the host to every player (seconds on a home upload). Runs
  of ids take a few bytes, typical selections 5-25x smaller, random ids 65%.
  tests/action-ids-codec.test.cjs.
- The pump watchdog stays out of the node harness (it has Blob/Worker; its
  pages model a busy main thread by late frames only, which a timer stepped
  around: backlog-fairness "a sustained busy client adjusts the shared pace").
- worker-walk: the test now orders walks to tiles the worker can reach (a
  tile walkable for it can lie in a pocket closed to it; ordered there, a
  unit rightly stops at the closest point).
- unit-collision-smoothness 1.51% (gate 1.5%, HEAD 1.49%): reversals are
  parked idle units shoved alternately by neighbours (178 of 391) and units
  arriving into the crowd (212, 55 with a carried push), mostly in the first
  100 ticks of the convergence. A separation-tuning job (Rust kernel), not a
  determinism issue (.claude/probes/smooth_bins.cjs).
- **Results depended on when the garbage collector ran** (worker-mode soak:
  one peer diverged at tick ~1720; extra per-tick work anywhere, DIVTRACE or
  a JSON capture, made it vanish). Auto heap arrays go back to the wasm heap
  when collected (FinalizationRegistry), so later allocations land on other
  memory per peer; the next navigation build's field pool is allocated
  uncleared (clearing ~300 MB cost 60-150 ms at 400k), and after its install
  slots no batch had written were read: (a) live slots missed (a pending
  slot the flush dropped as already made in the installed pool): the next
  pool now records the slots its batches were given (`made`) and the
  install makes the live ones missed (6-8 a match in the soak); (b) slots
  let go but still "made": releasing bumps the generation and the movement
  kernel takes a new generation of a made slot with its destination as
  "made again by a new build", so a unit still on it keeps reading it; the
  install copies such slots' content over (what they held before;
  SIM_RULES_REVISION 9). (Zeroing every dead slot at install cost an 80 ms
  tick at B800; clearing "made" at release instead made releases change
  behaviour, and release timing differs on a peer restored inside a
  rebuild window: the soak's spectator diverged.) Follow-up: the sweep
  should see every reference (armed kernel flows) so released slots are
  never read, and release timing should be synced for restored peers.
  B800 after (`.claude/s12-800k-b.log`): mean 64.7 ms, p95 94, max 148,
  navTick max 21 ms, 0 desyncs; 6 slots made at the install, 0 copied.
  Found by forcing
  GC on one peer (node --expose-gc, SOAK_HOST_GC), then which collector
  frees run (sim_wasm.js SIM_HEAP_GC_FREE bits, SIM_HEAP_GC_FREE_SITES by
  allocating stack line) to bisect the site. Debug: SIM_HEAP_POISON (a
  byte per peer for freed and uncleared heap). The soak forces host GC every
  5 ticks and poisons by default now.
- Still red, not ours: performance-regressions / render-frame-stability
  (renderer3d sceneTargetSize), visibility-history-performance (history
  ghosts, fails at HEAD); kernel-object-equivalence is obsolete (every peer
  disarms at the resync flush now, so kernel and object paths need not
  match).

### 2026-10-11 — tick and frame time spikes (user: the session's main goal)

Report: on `300000-1000.json` selecting things, above all repeatedly (all
units, another 90%, and so on, ~5 times a second), drops FPS to 7-8 and TPS
to 2-5. Reproduced in Edge with a new bench, `tests/selection-thrash-bench.cjs`
(SEL300 above): 600k units, 2D far view, full visibility, solo.

Machine note: every run of this session had the user's Firefox holding ~6 GB
(2 GB available, 0.3 GB during a run): the simulation's own time per tick
moved 45-65 ms between identical runs. Compare the spike counts and the
longest single calls, not the means.

**Why selections cost ticks.** The page never simulates, but it dispatches
the ticks (three ahead at most): a page task of 150 ms and more leaves the
worker without a tick to run. A selection made the page walk its units
through their views many times a frame and a tick, so the page stalled, so
the simulation did. Nothing in the worker depends on the selection.

Where the page's time went (profile of the box phase, 12 s, the page thread
90% busy): the info panel 2.9 s (17 rebuilds of 170 ms: every unit grouped by
a key string, summed through its view, every unit's id written into the
markup three times per group), the box's release 2.0 s (116-198 ms each:
`u.x`, `u.y`, `u.owner` through the views' getters for every unit),
`getActiveUnits` 1.1 s (a filter of 300k views every tick: `u.dead` went
through Unit's accessor, ~30 ns), the selection mask made again on every new
frame 0.5 s plus its own upload of five columns 0.46 s, the rebase of every
unit's drawn position 1.0 s (17-27 ms each time a frame came, selection or
not), the minimap's units 0.6 s (13 ms, 4 times a second), the bottom bar's
counts 0.2 s.

Changed (page; all of it applies to multiplayer, the page's work is the same
there):
- **The selection by the frame's slots** (hud.js `selectionIndex`): its
  units' slots, a mask per slot and its dead count, made once per selection
  (the array and its length tell) and kept by the frame's membership changes
  (`selectionNoteDead` from `_simClientUpdateStableSlots`; a restore's remap
  makes it again). Nothing walks the selection per frame or tick: the
  per-tick dead filter is a counter check (`selectionCompactDead`: at once
  for a small selection, twice a second for a big one), `getActiveUnits` is
  the selection's own array while nothing died and no subgroup is off
  (cached by the index's version otherwise), the GPU mask is the index's
  mask.
- `PageUnit.dead` is the view's own field (a class field: defined, not set
  through Unit's accessor).
- **Box selection from the columns** (main.js `_ownUnitsInBox`, renderer.js
  `get3DBoxSelection`): slot by slot in memory order, the 3D one projected
  inline; past 20k units in the frame the ground point alone decides (no
  drawn-mesh test per unit). The selection is then in slot order; its index
  is adopted from the slots just read (`selectionIndexAdopt`).
- **The info panel of a big selection** (over 300 units, the watched units'
  cap): unit groups from one pass over the selection's slots into bins of
  units alike in everything the panel sums (type, base and effective level,
  owner, frozen, sandy) in a small typed open table
  (`infoPanelUnitGroupsFromFrame`, `_infoPanelBinUnits`);
  `renderUnitGroupInfo` sums over the bins. A group's controls carry a token
  (`@group:<key>`) instead of every id, resolved from the selection when
  pressed (`infoPanelUnitIds`); long coordinate lists of building groups are
  tokens too (`infoCoordAttr` / `infoCoordText`: the panel's markup with 20k
  buildings selected is 84 KB, 978 nodes). Building group keys are kept per
  entity while groups are by type. Section heights are measured after the
  browser's own layout (asked for at once they forced it: ~25 ms). After a
  box the panel waits 160 ms once it is known to be costly
  (`INFO_PANEL_SETTLE_MS`): boxes in quick succession make it once.
- **One kill order per group** (`killUnit` takes `unitIds`): the panel's
  kill button sent one order per unit, each found by a scan of every unit
  (a 50k group: 50k orders of 600k compares). SIM_RULES_REVISION 10.
- **A new units frame waits for the shown one's motion to end**
  (sim_client.js: `heldPresentation`, shown by `simClientTickAlpha`): no
  unit's start is moved to where it is drawn now (the rebase's pass over
  every unit). While one waits the shown motion runs at 1.25x so the wait
  drains; a second frame arriving meanwhile shows the waiting one (with the
  pass only when the shown motion is under 80% done). Rebase passes 60 → 14
  per 12 s idle. Without frames being drawn (a hidden page, the node tests):
  as before.
- The selection mask draws from the glyphs' unit buffer (renderer3d.js
  `drawSelectionMask`: no second upload of five columns, 12 MB a frame).
- The minimap's units and the unit counts for the bars and the panel are
  made a slice of 100k units a frame (`_minimapUnitPaintStep`,
  `frameUnitSummaryStep`), shown when whole.

Changed (simulation):
- **Idle towers look again on a tick of their own** (tower.js
  `towerIdleCooldown`; SIM_RULES_REVISION 10): a tower that finds no unit
  sets its cooldown and searches for a structure; every tower of a base
  finding nothing on one tick did so again on the same later tick, for good
  (6k towers: a 45-60 ms `towersTick` every cooldown, most of it
  `_findTowerFloorTarget`). The idle cooldown is lengthened once to end on
  the tower's place (by tile) in the wheel of cooldown + 1 ticks; from then
  on exact. A function of the tick and the tile only (nothing new in
  snapshots). `towersTick` max 43-60 → 3-5 ms; its mean read 1.05 → 1.7 ms
  a tick across these runs (not explained: the same searches, spread; the
  shared structure lists are kept by changes, not per tick. To measure with
  tickbench, alone).
  With it: the idle cooldown is set once, after the structure searches found
  nothing (set before them and again on a find, the tower sat in the wheel at
  two different ticks), and `towersTick` lets a tower act only past its
  deadline (`gameTime > _cdUntil`): an entry left from a cooldown set again
  since never acts a tick early, so the wheel holds nothing a restored peer
  (whose wheel is made from the deadlines) could miss.

Tests. The corruption fuzz failed with the tower change, in a way that is
not the towers': its repairs' timing depends on when each corruption lands
(the trajectory moved, so they land elsewhere in the hash rotations). On
HEAD it fails the same kind of way once its schedule is shifted
(`await play(1150)` before the kinds: "playerResearch: state differs after
the patch"; 350 ms passes, 2750 fails): it passed by phase. Two of its
assumptions made explicit: `unitExtra` is a spreading kind (the extra unit
raises its neighbours' effective levels and their upkeep while its patch is
on the way: settled like the other broad kinds), and a building's level is
waited for as long as its hash round takes (each region once in
SNAP_HASH_SLICES * SNAP_HASH_GRID_ROUNDS = 400 ticks; it was given 6 s).
Mode 0 passes; mode 1 still fails ("rng: guest1 was repaired too": a late
follow-up of the playerResearch repair on guest1). **Open: a research
corruption's repair is not complete in one patch plus a settle** (the units'
derived tables after the delta patch: the gap noted on 2026-10-10), and the
fuzz should draw its schedule from several phases so it cannot pass by
phase. `frame-hud-summary` loads a slice of hud.js by text: the frame
summary's new state sits inside that slice.

SEL300, before → after (`.claude/selbench-s14-base300.log`,
`-base300-move.log` → `selbench-s14-c.log`; frames over 100 ms in 12 s):

| Phase | FPS | frame p95 ms | over 100 ms | TPS (applied) | tick gap p95 ms | worker tick max ms |
|---|---|---|---|---|---|---|
| nothing selected | 98 → 95 | 24.9 → 19.1 | 0 → 0 | 15.8 → 18.8 | 92 → 73 | 96 → 74 |
| 300k + 20k buildings selected | 44 → 79 | 66.7 → 29.3 | 16 → 3 | 13.3 → 19.1 | 203 → 81 | 126 → 69 |
| 5 boxes a second | 16 → 57 | 274 → 56.8 | 30 → 5 | 11.3 → 17.3 | 317 → 143 | 111 → 83 |
| 300k-unit move order | 22 → 87 | 141 → 20 | 25 → 0 | 12.5 → 16.9 | 216 → 81 | 119 → 92 |
| boxes over the moving army | 16 → 69 | 241 → 39.7 | 32 → 0 | 12.0 → 16.3 | 266 → 131 | 151 → 76 |
| control groups | 56 → 86 | 50 → 20 | 11 → 2 | 12.9 → 15.1 | 235 → 97 | 97 → 104 |

(Before, the page managed 17 of the 60 boxes asked for in 12 s; now all 61.
A box's release: 198 → 48 ms, most of it now the buildings' part.)

A second run of the final tree (`selbench-s14-d.log`, with the faster
playout while a frame waits) on a slower machine state (the worker 59-70 ms
a tick, so 12.5-16.3 TPS: the simulation's own time, not the page's): FPS
110 / 94 / 64 / 102 / 67 / 93 over the six phases, frame p95 16.6 / 17 / 50 /
16.7 / 49 / 19 ms, frames over 100 ms 0 / 3 / 4 / 1 / 6 / 0; rebase passes
per phase 0 / 1 / 5 / 0 / 5 / 0 (60 before). Its worst frames (288 and 367
ms, once each) fell in functions that take ~1 ms otherwise: the page's
major collections (see below).

3D (`MODE=3d`, `selbench-s14-3d*.log`): everything selected 85 FPS, frame
p95 19.7 ms; 5 boxes a second 52-54 FPS, p95 68 ms. A 3D box's release is
still 45-65 ms over 300k own units (`get3DBoxSelection`: the positions'
four columns and the projection per unit ~25 ms, the buildings through
their views ~10 ms); the last change there (no read of each unit's view) is
not in those numbers.

Verified on the final tree: `run-regressions` both modes 217/228 (218 at the
last session: the ten known failures, and the corruption fuzz in worker mode,
above); `browser-mp-gui-fuzz` (a match in two real Edge tabs, 258 controls,
4149 ticks): 0 desyncs, 0 hash mismatches, 0 errors, 0 stalls;
`ui-longtask-survey` at 200k units: 121 controls, 0 errors, the 3D view
switch the only slow one (336 ms, as before). SEL300 was run solo only: the
multiplayer bench (`render-tps-bench`, host and guest pages) was not run this
session.

Spikes left, by what the bench shows (largest first):
- **The info panel** still takes 50-60 ms when made anew for 300k units and
  20k buildings (126 ms the first time): the buildings' groups are still made
  through their views (`renderEntityGroupBlock` ~12 ms, grouping ~10 ms, the
  controls ~5 ms), the units' bins ~5 ms, the browser's style and layout of
  ~1000 inline-styled nodes ~25 ms. Next: building groups from the structure
  table's columns in bins like the units', and patching the panel in place
  across selections of the same groups.
- **A unit frame's arrival**: `renderer3d.render` 13-43 ms on a new frame
  (`bufferSubData` of 48 bytes a unit, 29 MB at 600k: columns that changed
  or not), and the membership pass (`_simClientUpdateStableSlots`: a new
  600k-element list on every tick with a death or a birth, ~5 MB of garbage
  a tick in a battle: the page's major collections, one 220 ms pause seen).
  Next: upload only x/y/px/py/energy/flags/facing each frame (the rest when
  the metadata revision moves); the list kept and patched, or made only for
  code that asks for it.
- **The presentation worker builds a frame in 95-120 ms at 600k units**
  (fillUnits ~70 ms: ~20 passes over every slot; buildRenderBuckets ~18 ms),
  so frames reach the page 7-9 times a second, not 20: the drawn motion is
  interpolated over ~120 ms. Not a spike, but the visible smoothness at this
  scale. Next: the slow columns (owner, r, levels, light, phase) only when
  the metadata revision or membership moved; then the fill as a Rust kernel
  on the shared heap (the frame inside the wasm memory: the UNIT_FRAME item).
- **Orders of a whole army**: the tick that takes a 300k-unit order spends
  57-76 ms in `processActions` (ids decoded, cleaned, stamped one call each:
  `_orderStampGet`/`Set` ~15 ms, decode and clean ~8 ms), and the page's
  click 79 ms (`getActiveUnitClasses` 17 ms, the ids' encoding). Applying
  is sliced already (3000 units a tick).
- Worker, steady: `workerSearchTierStep` max 30-33 ms (mean 7), 
  `simParallelBackgroundWait` 10-17 ms a tick with max 30-39 (the helpers
  are late in the browser, where the page, the presentation worker and the
  GPU process compete for the cores; ~0 in node), `simMoveRun` max 28-54,
  `_acqTierStep` max 14-23.
- Group controls of thousands of buildings still send one order per
  building (`setBuildEnabled` and the like per coordinate).
- At 300k per team the simulation alone does not hold 20 TPS in the browser
  on this machine as it was loaded (45-60 ms a tick): the plan's kernel work
  (MOVE, the index, the worker tier) is still what TPS needs.

### 2026-10-11 (later) — known failures; drawn motion; ticks past a stalled page

User: fix the known failures or the tests; then the spikes, worst first,
major reworks allowed; **a spike must not drop TPS** (one player's stall is
every player's tick rate in a match); the page should not stall either.

**Known failures (6 files).** `visibility-history-performance`,
`render-frame-stability`, `performance-regressions`, `lod-visible-budget`:
the tests followed the code (the units are the live list; the page shows the
presentation's tick; a selection mask without a selection; the columns'
`player`). `kernel-object-equivalence`: removed (its premise, JS kernels
beside the Rust ones, is gone). `unit-collision-smoothness`: the
separation's share of a push 1.0 → 0.8 (`UNIT_SEPARATION_TIER_GAIN`;
reversals 1.45% → 1.10%, overlap 5.4% → 7.1%; 0.6 gives 1.01%, 1.15 gives
2.5%, 1.3 gives 11.6%), gate kept at 1.5%. `multiplayer-corruption-fuzz`:
two real bugs in the patch decode (`utils_snapshot.js`), found by shifting
the fuzz's schedule (`SHIFT_MS`): a unit a patch removed stayed counted in
the chunk/type/block planes and in its visibility cover (now taken out
before the unit state is collected), and a patch that rebuilt a player's
stat tables (a research rolled back) left that player's other units with
their old effective stats until their staggered refresh (now refreshed in
the decode). Passes in both modes at shifts 0, 600, 1150, 1900, 2750.
`SIM_RULES_REVISION` 11.

**Drawn motion (user: constant micro-jitter, back and forth).** Two causes.
(1) A presentation frame's motion ran from its arrival over the average gap
between arrivals: a frame a few ms early or late cut a step short or held a
unit for a frame (a lone unit's drawn speed varied by half at every tick:
CV 0.204, 24 held frames of 473). Now a playout clock (`sim_client.js`
`_simPlayArrived` / `_simPlayAdvance`): frames queued by tick, a play
position in ticks advancing with the drawn frames' time at the frames' own
pace, a set distance behind the newest (their spacing plus what their
arrivals vary by), its rate nudged to hold that distance; no rebase pass.
CV 0.040, no held frames. (2) The detailed unit layer (3D models up close)
was cached by `gameTime`, the page's tick, while the units came from the
presentation's frame: on a frame between the two the layer drew the old
tick's records at the new frame's alpha (back, then forth). Now keyed by the
units' frame (`unitsRenderStamp()`, `_pageFrameSerial`). Guard:
`render-frame-stability` reads the layer's own records (0 reversals; 24 with
the old key). Probe: `tests/motion-jitter-probe.cjs`.
**Own units' light** (flicker between areas): the frame's light column
gives a unit of the player (or one it watches) at least the full-light
range, as the 0.3 margin was meant to; the shader and the middle models
follow.

**Ticks past a stalled page.** Measured first
(`tests/page-stall-tps-probe.cjs`: a host and a guest page in Edge over
WebRTC, a page's main thread held busy on purpose, each worker's tick times
around it): the page dispatches ticks 3 ahead, so a stall over ~150 ms
starved its worker; a host page's stall stopped the sealing for everyone,
and a guest page's stall left that guest behind, which the shared pace then
slowed everyone down for.

| stall | before: ticks lost, host / guest | now |
| --- | --- | --- |
| host page 250 ms | 5 / 5 | 0 / 0 |
| host page 500 ms | 11 / 12 | 0 / 0 |
| host page 1000 ms | 25 / 25 | 0 / 0 |
| guest page 500 ms | 6 / 8 | 0 / 0 |
| guest page 1000 ms | 9 / 9 | 0 / 0 |
| alone, 500 ms | 7 | 0 |

(Longest gap between two ticks through any of them: 55-70 ms. Ten stalls of
120 ms in two seconds: 0 lost. The same at 100k units. Orders given right
before a stall by the stalled page, and during it by the other, reach every
unit; the peers' state hashes are equal afterwards.)

How (`sim_worker.js` `_simAutoStep`, `sim_client.js` "ticks the worker
takes by itself", `main.js` `lockstepAdoptAuto*`):
- The page's heartbeat (every pump, frame and watchdog message) and the
  tick clock live in the shared control block. When the pump has not been
  heard for 70 ms (170 for a hidden page), the worker goes on by itself on
  the page's tick clock.
- It runs ticks whose commands it holds: every sealed bundle is handed to
  the worker at once (`simClientNoteSealed`: a host's as it seals, a
  guest's as it commits). Alone: ticks without commands.
- A host's worker **seals** the ticks its page has not, without anyone's
  commands, as far ahead of their deadlines as the page would (150 ms), and
  sends those bundles itself.
- **The worker's own data channel**: each page link gets a second,
  negotiated RTCDataChannel on the same peer connection, transferred to the
  simulation worker as it is made (`simClientNetAttach`; Edge and Chrome
  hand channels to workers; where they do not, the other end closes and
  nothing changes). A host's worker sends every sealed bundle over it (the
  page's and its own); a guest's worker keeps them, so a guest's own stall
  costs that guest no tick either, and passes on to its page the ones the
  host's worker sealed.
- One source per tick: the page claims each tick it dispatches, and a host
  each tick it seals, by a compare-and-exchange in the shared block; the
  worker claims the same way. The worker tells the page of each tick it
  took (`autoRan`, `autoSealed`), and the page's lockstep moves on from
  those notes alone (history, bookkeeping, the tick clock).
- Commands are never lost: a tick the worker sealed is, for the page, a
  tick sealed without every packet (the late-seal rule): packets that were
  there or come later are carried to the next tick, the host's own too; a
  guest sends its packet again for a tick its worker ran.
- The page bounds it: the limit word is the first tick the worker must
  leave alone (a resync patch's tick, a join, a flush tick; 0 while a match
  is paused, restoring, migrating). Lowered only once the worker is out of a
  claim (an intent word). Resync points are planned past everything sealed
  or taken (`_resyncHostFirstOpenTick`). A request to the worker waits for
  the page to have heard of every tick the worker took. At most 60 ticks a
  stall (3 s): longer is an outage, the match's own rules.
- Late packets no longer cost a tick either: with ticks dispatched ahead, a
  tick still missing a guest's packet is sealed without it once the
  worker's queue is down to 2 (`HOST_LATE_SEAL_LEAD_TICKS`), not 50 ms
  after it was due; and while that guest stays behind, the next ticks are
  sealed as early as ever. The shared pace no longer counts a stalled page
  as a slow simulation.
`?simauto=0` turns it off. Not covered by the node harness (its worker has
no timers or shared block of its own): the probe with `GATE=1` is the check.

**Page tasks (the page should not stall either).** New tool:
`.claude/profspikes.cjs` (a page profile's longest busy stretches, or with
`TASKS=1` its longest single tasks, with what ran in them). SEL300 in 3D,
five boxes a second, on the tree as the order-marker work had left it: 9.8
FPS, frames of 220-266 ms. Fixed:
- `getOrderMarkers` walked every selected unit's view on every new frame
  (60-80 ms at 300k) and made a marker with a string key for each of 20k
  rally points: now from the selection's slots in the frame's columns
  (views only for units with an order on its way or an attack target),
  whole-number keys, at most 2000 markers, and a big selection's list kept
  150 ms unless an order is pending.
- 3D box release (`get3DBoxSelection` 52-68 ms): the far view's unit pass is
  a function of typed reads only, its hits' slots handed to the selection's
  index (no pass over the selection for them): ~18 ms.
- `_infoPanelBinUnits`: a selection of a quarter of the slots or more is
  read in slot order (the mask tells which), not in selection order.
- `getUnitById` on the page is the frame's id map (it made a 600k-entry map
  again after every birth or death when a rally-to-unit marker was drawn).
After: 21.7 FPS in the same phase on the same (loaded) machine. Still the
longest tasks there: the unit columns' upload on a new frame
(`bufferSubData` 33-61 ms; 110-140 ms while the page was saturated), the
info panel's building groups (`renderBarrackGroupInfo`: every member's
stats through its view, ~20 ms per group of thousands; next: bins from the
structure table as for units), `pushMarker` of up to 2000 markers a frame.

### 2026-10-11 (evening) — boosts, map shapes, UI fixes (user's list)

- **Research queue item's menu closed within a second**: it held the task
  object, and beside the worker every tick brings new ones. Told now by
  stat and target level.
- **Mines could not be selected**: a mine's view read energy 0 (the
  structure table's column) and the selection pruned it as destroyed.
  Mines and drops have no energy again. The ★ mine has a thumbnail.
- **Display settings apply at once** (`applyVisualSettingChange`: the
  caches made under the old setting are dropped; mine amounts, rally lines,
  outlines, level and range visibility).
- **⚡/★ rates read 0** in the side panel and on the bar: their logs are
  filled inside the worker. Each tick's sums by source now come with the
  tick's events (`_simDeltaEvents`), and the upkeep table with the state.
- **Negative stockpiles scale nothing; boosts instead** (`data_dynamic.js`
  BOOSTS, rules 12). Per thing, an energy boost and (units) a ★ boost of
  0-4 steps, a step one thing level: every stat but health, move speed and
  ★ per tile is read `steps` levels up the thing's table for the energy
  boost, move speed and ★ per tile for the ★ boost; the thing's own
  level is untouched; upkeep and ★ per tile rise with it, which is the
  cost. A stockpile below 0 switches that resource's boosts off (checked
  every 20 ticks). Applied like a finished research: the tables rebuilt in
  place, units at their staggered refresh, buildings at their research
  sweep, pop cap and adjacency at once. Order: `setBoost`. UI: two rows of
  slots on every tile of the bottom bar's top row (grey ★ over orange
  ⚡; x1 x2 x4 x8 x16; one tall row for things without a ★ boost),
  per-slot hover text, paler while that resource is in debt or the boost is
  being taken up; the thing's menu says it in words. The effects popups are
  gone. Test: `boost.test.cjs` (replaces `resource-penalty-stats`).
- **Map types hold the density's mines in a shape of their own**
  (`generateResourceMinesMixed`, `mapMineLayout`): the first N tiles by a
  per-type order are the mines (so more mines make thicker roads, a wider
  ring, bigger islands), the first of them by a per-type score are ★
  (exact counts). Arena: a ring, the resources in wedges; island: one disc,
  in rings; islands: four islets of one resource each by every spawn;
  solar system: a sun of energy and planets of one resource each on four
  orbits; crossroads: two roads, lines of one resource then the other;
  random as before. Spawns follow the shapes (outside the island, inside
  the ring, between the roads at equal distances). Pictures:
  `node .claude/mapshots.cjs`.

## Next

Order set by the user (2026-10-09): main thread stable below 50 ms (aim
~40) at B800 first; the determinism fixes after that. 2026-10-11: no tick or
frame time spikes of any kind is the goal; the list of those left is at the
end of that day's entry.

0. Main thread: the items above, biggest first: MOVE (layouts, steering
   shared per route/cell), separation commit, unit pass (worker events in
   the kernel), worker tier takes; battle-setup spikes (visibility cover
   rebuild, first updates). Hash: a typed structure table (towers, barracks,
   spawners as accessor-backed columns; floor items and mines made class
   instances) so the structures' part is a kernel too (or region sums kept
   by their setters). Then the determinism suite failures (above).
1. Navigation (plan E.4/E.5), for the p99 gate: the rebuild's remaining
   serial start (batching every live field, binding), foreground kernels
   starved by the remake of every live field (smaller background jobs or
   fewer fields remade: only those whose clusters changed), and the burst of
   re-routing after an install.
2. MOVE kernel CPU (74.6 ms at 800k; 14 ms of foreground wall): dump and
   replay (kdump + wbench) to split its passes, then the motor plan (A).
3. Effective-stats apply (~3.4 ms), separation FINISH (30 ms CPU): see the
   profiles above.
4. Next batch, in order (B800 steady ms): MOVE 19 (a fresh kdump at B800
   with `.claude/probes/kdump_mv.js` + rbench DBGC: which lanes leave
   step4/combat4 for the scalar path, the bytes touched per unit; narrow
   columns, i32 1/8 px coordinates, then SIMD); the unit pass's ~290
   Unit.update calls (worker trips via helper pathfinding, node advance,
   worker checks and wakes in the kernel); the structure table and
   structure hits kernel (then the structures hash as a kernel: 3.3);
   orders (typed target/order fields); effective stats (count the eff.flag
   kinds first); visibility (phase-0 commit/post of _visCoverUnitsStep:
   measure first). Then the desyncs above. (Hash: 3.85 ms, see the structure table above.)
