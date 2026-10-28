# Simulation optimization: progress log

Working log for `SIMULATION_OPTIMIZATION_REFINEMENT.md` (the plan). Update this
file at the end of every work session: what changed, what was measured, what
is next. Newest entries first within each section.

**TPS spike investigation:** read `AGENTS.md` and
`tests/CHAOS_SPIKES_BENCHMARK.md`. Use the existing per-tick trace/profile
slicer to inspect the previous, slow and next gameplay tick across all
threads, plus a nearby normal tick. Prioritize gameplay p99/max and slow-tick
counts over mean TPS; loading before play is separate. Historical bit equality
is diagnostic; current implementation determinism and intended behavior are
required.

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
