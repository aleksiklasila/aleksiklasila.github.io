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

## Next

Order set by the user (2026-10-09): main thread stable below 50 ms (aim
~40) at B800 first; the determinism fixes after that.

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
