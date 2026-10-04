# Simulation optimization: progress log

Working log for `SIMULATION_OPTIMIZATION_REFINEMENT.md` (the plan). Update this
file at the end of every work session: what changed, what was measured, what
is next. Newest entries first within each section.

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
