# Navigation rebuilds: fast, fixed memory, off the main thread

Goal (user, 2026-11-02): wall changes reach units' routes within about a
second at any TPS, with no TPS drop, in the extreme case too (a battle
destroying thousands of buildings in one tick); no memory growth during play
(wasm32: 4 GiB); all build work on the helpers.

## Done
- 2026-11-03: the complete 16-stage background chain is wired and the old
  JavaScript sizing/hierarchy glue removed. Match-start and restored builds
  use the same kernels. See the completion entry below for validation and
  measurements; the 2026-11-02 handoff is retained as historical context.
- 3 profiles: ground, air (collectors fly: data_static.js isFlying), builders
  and salvagers of every player (ground minus every structure; a mined-out
  mine walls again). flownav.js NAV_PROFILES = 3; tch.rs, ord.rs, wai.rs.
- Flyers: mv.rs look_direct before the shared looks (a clear rectangle: no
  cache traffic).
- Fixed memory: build slots (flownav.js navReserve, _navSlots, arrays addressed
  through the slot's header; ground 2 x NAV_GROUND_BYTES_PER_TILE, builders 2 x their
  start build + mines, air 1 exact); a build too big for its slot dropped
  deterministically (_NAV_SLOT_FULL). Destination field pools fixed
  (NAV_FIELDS_NARROW / WIDE; routes use the atlas).
- Schedule compressed: install 2 simulation steps after posting at dk >= 3,
  otherwise 3 steps (previously ~164 base ticks, then 6-7 staged steps).

## Measured problem (Edge, 1M/250k chaos, wp12)
- ~22 ground rebuilds in 680 ticks; main-thread navTick 2.86 s: collect waits
  1.76 s (a step covers several ticks, all stages land in 1-2 steps), JS glue
  ~40 ms a rebuild (navBuildNodesFinish ~21, navAtlasStart ~9, navBuildStart
  ~5, _navNextInstall ~3, _navShareBuild ~2).
- Builder slot 157 MB (bound: every mine adds 2 nodes); real ~24 MB.

## Plan
1. DONE Builder bound: only mines on a cluster border row/column add nodes
   (157 -> 47 MB a slot on the chaos scene).
2. DONE Stages by simulation step (flownav.js _navJobAdvance, _NAV_STAGES,
   _navStageGap: 1 step apart at simDk >= 3, else 2; snapshot si/calls/
   nextAt/gap). Edge wp13: main-thread _navJobStep 2861 -> 531 ms, collect
   waits gone, mean step 556 -> 423 ms, p95 686; 10 rebuilds in 70 steps.
   Arrays written whole not cleared (fields, wall): -184 ms more.
3. DONE Cross-profile sharing off (NAV_SHARE_BUILDS = false; its test turns
   it on).

### Single background chain (completed 2026-11-03; original plan)
Each stage boundary costs a step (the main thread sizes and binds the next
stage's arrays), so a build is ~6 steps: ~3 s at 2 steps/s. One chain:
- Kernels read their arrays from the slot arena + a build header (navb.hdr:
  per array its byte offset, and the counts k, np, e, total, L, pool...), not
  from names bound per stage.
- Glue kernels (1 job each, in the chain) size and place the next arrays in
  the arena (bump offsets in the header): nodes finish (nodeBase, nodeTile,
  nodePair, field area, adjN), graph alloc (adjStart, adjA/adjC), parts finish
  (partBase, partCluster, nodePart, comps), atlas levels (the JS
  hierarchy loops of navAtlasStart), tables alloc (co, ct), clear prefix and
  header (navAtlasFinish). A full slot: the header flags it; the install
  drops the build (deterministic).
- The main thread: posts the chain at the job's start; at the install step
  (a fixed number of steps later, 1-2 at long steps) waits for the chain
  (normally done), makes the nav object's views from the header, binds,
  installs.
4. Port the JS glue to wasm kernels in the background chain, by cost:
   node numbering (navBuildNodesFinish), atlas levels (navAtlasStart), parts
   (navBuildPartsFinish), graph offsets (navBuildGraphAlloc), wall copy
   (navBuildStart), table offsets / clear prefix (navAtlasTables/Finish).
   Sizes from in-kernel bump allocation in the slot's arena (offsets in a
   build header); the main thread makes views and flips at install.
5. Measure: main-thread nav ms a step, helper ms a rebuild, ticks/steps to
   install, p95, memory.

## Handoff (2026-11-02, session ran out of usage)
State of the tree (nothing committed; earlier work staged by the user):
- DONE and tested: items 1-3 above, plus the fields/wall arrays no longer
  cleared. Full test list last passed before item 2; after items 2-3 the nav
  tests pass (nav-background, -rows, -shared-build, -reach, -flow-width,
  -look-cache-wall, -build-interleaving, -build-kernels, -field-sweep,
  nav-atlas). Two-peer determinism (6 maps, 4 helpers) last run after the
  slot change, not after the step-based schedule: run it first.
- IN PROGRESS: wasm/src/navg.rs (new, `mod navg;` added to lib.rs): k_navg
  glue kernels (modes 1 nodes finish, 2 graph alloc, 3 graph finish + parts
  + atlas block arrays, 4 atlas levels, 5 tables alloc, 6 clear prefix +
  atlas header), ported 1:1 from the JS glue, allocating in the slot from
  the build header (H_* / O_* constants). It compiles but the build rejects
  it for a data segment, so it is NOT registered (`mod navg;` removed from
  lib.rs; the shipped sim_wasm_bin.js is the last good build). To resume: add
  `mod navg;` after `mod arq;`, build, and remove the data segment (likely
  the `[0u8; 16]`-style or `match` lowering, a bounds-checked index, or a
  panic path from `/` by zero in cdiv: use checked guards / get_unchecked).
- NOT STARTED (JS side of the single chain):
  a. flownav.js: a NAVH header layout identical to navg.rs (words 0-12
     counts/top/cap/full/B/temp, 16-58 offsets); navBuildStart writes the
     header at the slot's start (offset 0, 256 bytes), places wall/cost/h/
     partL/partN/ns/nsc, copies the walls, sets H_TOP, H_CAP = slot length.
  b. Kernel wrappers that resolve '#<header word>' names to slot + offset on
     the helper (a _navRust beside sim_parallel.js _simRust; never cached),
     and take k/np/e/B/total/L/nj from the header into the params (P[1]=k,
     P[8]=k, P[9]=B, P[10]=e; route jobs from H_NJ). Job counts posted for
     the slot's most (e.g. nodes = slot bytes / (2*C*C)); a job past the
     header's count returns at once. Skip every kernel when H_FULL.
  c. The chain (build lane): COST x2, NODES, navg 1, LOCAL, GRAPH 0, navg 2,
     GRAPH 1, PARTS, navg 3, ATL_BLOCKS, navg 4, ATL_ROUTE, navg 5,
     ATL_TABLES, navg 6 (16 of SIM_PAR_BG_STAGES 24).
  d. Install: views from the header (navBuildFinish's object + atlas object
     with header = the O_ATLH view), _navNextStage/_navNextInstall as now;
     H_FULL -> _navSlotFullNote + drop (as _NAV_SLOT_FULL). Job stages:
     [start + post chain] -> [collect + views + window] -> [install].
  e. Make the synchronous navBuild run the same stages foreground (so a
     restored peer's builds equal the host's), then delete the JS glue
     (navBuildNodesFinish, navBuildGraphAlloc/Finish, navBuildPartsFinish,
     navAtlasStart's loops, navAtlasTables/Finish/Header) and update
     tests/nav-build-kernels and nav-build-interleaving which call them.
  f. Check: nav tests, two-peer determinism (0/4 helpers), the 1M chaos
     scene in Edge (main-thread nav well under 1 ms a step; install steps;
     p95), memory (simHeapPlayStats: 0 in play), then log in
     OPTIMIZATION_PROGRESS.md.
Measurements so far (Edge, 1M/250k chaos, regenerated scene): 3 profiles
nav 240 -> 87 MB; in-play allocations 125 MB/30 s -> 11 KB (slots); main-
thread navigation 2.86 s -> 0.53 s per 32 s (before the clearing fix);
mean step 556 -> 423 ms; slots ground 2 x 96, air 29, builders 2 x 47 MB.

## Completion — 2026-11-03

The 16-stage chain is implemented and the production wasm32 binary rebuilt
(hash `21ce5225af2a2064`). Nothing was committed in this continuation.

- `wasm/src/navg.rs` is registered. Positive divisors in `cdiv` and the
  atlas cluster-width calculation remove the division panic paths/data
  segment; the ordinary build's no-data-segment check passes. Temporary
  allocations round the slot's upper bound down to preserve alignment.
- `flownav.js`: one 256-byte build header, followed by 384 bytes of
  installed/next metadata for the three profiles. Array offsets and counts
  match `navg.rs`; all sizing, node numbering, components, atlas levels,
  table offsets and the clear prefix are Rust stages in the arena.
- `SIM_KERNEL_NAV_CHAIN` (135) carries the arena address in each stage's
  immutable parameters. Helpers resolve offsets at execution, never from
  cached array addresses or changing global bindings. Stages whose counts
  are discovered by earlier stages distribute their actual native jobs
  over at most 128 tasks; no enormous worst-case list of empty jobs.
- Chain: COST x2, NODES, glue 1, LOCAL, GRAPH count, glue 2, GRAPH write,
  PARTS, glue 3, ATL_BLOCKS, glue 4, ATL_ROUTE, glue 5, ATL_TABLES, glue 6.
  Match-start builds execute this same sequence in the foreground.
- Schedule: post, collect/stage, install. The complete chain gets one step
  at dk >= 3, two at smaller dk; destination fields get one further step.
  Thus an uncontended profile installs 2/3 steps after posting. Completion
  time never chooses the install step. Another dirty profile can still
  wait behind the current profile; this is not a guarantee of 2/3 steps
  from every edit when both profiles are dirty.
- Atlas-only windows skip destination-field bookkeeping if those pools
  have never been used. A first fallback request expands the window before
  accepting the field. Bind records live in the arena, publish bindings
  are batched, and the copied snapshot/continuously maintained diff count
  avoid two redundant whole-map wall comparisons.
- Field-sweep scratch (16 KB) is reserved at match start. The old JavaScript
  glue functions and their intermediate bindings are removed. Arena overflow
  skips all subsequent kernels and deterministically drops the build.
  Reset/restore collects a pending build before its arena can be reused.

Validation:

- Six-map multiplayer chaos determinism passed before the rewrite (host
  with 4 helpers), and after it with 0 and 4 host helpers; guests have no
  helpers. Each map compared 2,598 hashes and repaired only its two forced
  divergences. Logs: `tests/test-runs/nav-chain/final-determinism-{0,4}.log`.
- Navigation build kernels, interleaving, background, rows, sharing, reach,
  flow width, look-cache walls, field sweep and atlas tests pass. So do
  memory-allocation-regressions, area-search-range and structure-targeting.
- New `tests/nav-chain-lifecycle.test.cjs`: 0/3 helpers; bounded overflow
  with a guard region; same-address reuse with open/fully blocked/open
  geometry; zero heap allocations in a reserved rebuild; snapshots at
  both boundaries at dk 1/4/20; repeated restore while a chain is pending;
  first fallback field requested inside an otherwise empty atlas window.
  The legacy 512 MB speculative-reservation assertion was updated to
  check the actual configured population reservation.

Final Edge measurement (`scenes/chaos-1m-250k.gz`, 11 helpers, 40 seconds):

- 88 navigation calls: mean **0.393 ms**, p50 0.435, p95 **0.705**, p99/max
  **1.080 ms**. Only the first measured call exceeded 1 ms. 29 installs,
  every one exactly **2 simulation steps after posting**, no dropped builds.
- `simHeapPlayStats`: **0 allocations, 0 KB, 0 MB grown** over this measured
  gameplay window. Fixed navigation slots: 323.80 MiB.
- Measured simulation unit-list population 268,662–575,323 (the scene starts
  much larger and casualties continue). 111,932 successful spawns; 24,681
  research, 32,614 collector and 28,854 astar-collector deposits, using the
  worker kernel's counters. This is not a sustained-one-million-unit run.
- 77 available whole-step trace rows in the measurement window: p95 499.84,
  p99/max 535.92 ms; 3 above 500 ms. These are separate from the 88 nav calls.
- Raw log, navigation/install records, heap census, trace and summary:
  `tests/test-runs/nav-chain/edge-final{.log,-data.json,-trace.json,-summary.json}`.
  The first Edge run exposed the unused field staging and sweep allocation;
  it is retained as `edge.log`, `edge-data.json`, `edge-trace.json`.

Serial headless comparisons and attribution (all retained, no discarded runs):

- Large mixed chaos, 1,000,004 starting units / 250,000 structures,
  11 helpers, dk=1, 80 steps with 20 warmup. Files in
  `tests/test-runs/nav-chain/`: `baseline.json`, `candidate.json`, `final.json`
  and their `.jsonl` sidecars. `candidate` used a two-step field window;
  `final` used the final one-step window, before the atlas-only skip.
- Steady wall p95 / p99 / max in ms: baseline **303.41 / 341.65 / 341.65**;
  candidate **265.74 / 302.32 / 302.32**; final-before-skip
  **434.29 / 495.34 / 495.34**. All had zero steady steps above 500 ms;
  counts above 1.5x the median were 3 / 1 / 3. Whole-step timings varied
  across phases and do **not** establish an overall TPS or hitch improvement.
- Steady main-simulation navigation mean / max: **1.632 / 14.691 ms**
  baseline, **0.321 / 0.904** candidate, **0.486 / 3.420** final-before-skip.
  The completed Edge run above measures the last staging optimization.
- Actual steady populations: baseline 290,723–433,655; candidate
  290,690–433,638. Successful spawns 20,436 / 20,532; research deposits
  25,933 / 25,933; collector deposits 5,813 / 5,727; astar deposits
  3,865 / 3,770. Full population, births/deaths and work counters remain in
  each JSON. The synthetic fixture also has large first-tick/early setup
  allocations (828 MB in the candidate); the count stops changing after
  step 19. The zero-allocation claim concerns reserved rebuilds and the
  measured browser gameplay window, not that synthetic warmup.
- Separate all-thread diagnostic: `profile.json`, its main/helper CPU
  profiles, `profile.json.spike-analysis.json`, `helper-navigation-cpu.json`.
  The existing analyzer compared previous step 20, slow step 21, next 22,
  and reference 28 (same non-burst status as 21). Wall times:
  309.33 / 334.10 / 290.31 / 229.87 ms; nav:
  0.831 / 0.444 / 0.014 / 0.475 ms. Step 21 includes 24.21 ms GC;
  spawning is 34.82 ms versus 9.65 in the reference, movement 124.06
  versus 104.94. The preceding burst also spends 79.06 ms in actions.
- Navigation kernels sampled about 13.3 aggregate CPU-seconds on helpers
  over roughly 15 rebuilds (~0.89 CPU-second/rebuild), with no sampled
  build-kernel time on the simulation thread. These are CPU sums, not
  wall latency; 5 ms sampling is coarse for the small glue kernels.

Remaining bottlenecks/limits: whole builds still consume substantial helper
CPU (local fields and atlas routes dominate), and can contend with foreground
work. The rewrite removes the serial glue and scheduled stage waits; it does
not make rebuilds incremental. Movement, spawning/structure work, GC and
scheduling remain the whole-step tail investigation. Dirty profiles are
serialized, and an exhausted fixed slot still keeps the previous build.
