# Navigation rebuilds: fast, fixed memory, off the main thread

Goal (user, 2026-11-02): wall changes reach units' routes within about a
second at any TPS, with no TPS drop, in the extreme case too (a battle
destroying thousands of buildings in one tick); no memory growth during play
(wasm32: 4 GiB); all build work on the helpers.

## Done
- 3 profiles: ground, air (collectors fly: data_static.js isFlying), builders
  and salvagers of every player (ground minus every structure; a mined-out
  mine walls again). flownav.js NAV_PROFILES = 3; tch.rs, ord.rs, wai.rs.
- Flyers: mv.rs look_direct before the shared looks (a clear rectangle: no
  cache traffic).
- Fixed memory: build slots (flownav.js navReserve, _navSlots, _navArr from
  the slot's arena; ground 2 x NAV_GROUND_BYTES_PER_TILE, builders 2 x their
  start build + mines, air 1 exact); a build too big for its slot dropped
  deterministically (_NAV_SLOT_FULL). Destination field pools fixed
  (NAV_FIELDS_NARROW / WIDE; routes use the atlas).
- Schedule compressed: install 12 ticks after start (was ~164).

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

### Single background chain (next)
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
