# Simulation optimization: progress log

Working log for `SIMULATION_OPTIMIZATION_REFINEMENT.md` (the plan). Update this
file at the end of every work session: what changed, what was measured, what
is next. Newest entries first within each section.

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
    ~13 ms a tick in ACTIVE).

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
