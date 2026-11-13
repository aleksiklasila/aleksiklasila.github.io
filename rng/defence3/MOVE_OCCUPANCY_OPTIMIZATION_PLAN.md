# Movement: analysis and plan (2026-11-12, rev 3)

Scope: everything a unit's movement costs a step: `mv_move` (kernel 8),
`mv_move_occupancy` (kernel 89), the steering looks (`mv_flow_pending` /
`mv_flow_exact` / `mv_flow_commit`), `occ.rs`, `traffic.rs`, and the serial
tail of `simMoveRun`.

Constraints (user, 2026-11-12): outcomes need not match today's. The game
must stay deterministic (peers, helper counts, restores) and behave
approximately as now (flow through crowds, leaders before followers,
standing units giving way, swaps, pressure steering sideways only). Major
reworks are fine; no half measures: take what the hardware allows.

Rev 3 changes the target. Rev 2 made the three stages cheaper; rev 3
removes the per-unit, per-step walk over the unit columns altogether: a
unit that is only walking, standing or parked is stepped from a compact
block-ordered table and nothing else. A prototype of that hot path was
built and measured (section 2).

Raw data: `tests/test-runs/move-occ-plan-20261112/` (helper profiles of a
`--features=prof` build at dk 1 and `dk4/`, schedule probe output, debug
counters at dk 1 / dk 4, `counters.cjs`, the prototype in `mvproto/`).
`tests/occ-sched-probe.cjs` and the counter probe take `DK=n`.

## 0. Status (2026-11-12)

- **Stage 1 done** (steers by look, not by ticks): helper CPU a step 1,012 -> 811 ms at dk 1, 1,596 ->
  1,281 ms at dk 4 (looks 281 -> 127, mv_move 132 -> 102, occupancy 321 -> 285). Details and the two
  faults the checks found (wall keys are peer-local; the arrival windows stay in base ticks) in
  OPTIMIZATION_PROGRESS.md; data in tests/test-runs/move-occ-stage1-20261112/.
- **Stage 2, first half tried and not kept**: testing every candidate sweep against one read of the
  bitmap around the mover gave identical outcomes and no gain. The preference table (a behaviour
  change) is not made yet; it belongs with stage 3b, where the rows make the reads cheap.
- **Stage 3a done** (wasm/src/mvt.rs, sim_occupancy.js mvt*): the table, the marks at the writers outside
  the movement, sync, rebuild at a restore, the audit (tests: MVT=2; page: ?mvt=2).
- **Stage 3b, first part done** (the table is live, always on): kernel 89's block job walks its block's
  rows (not the tile index), ordered by LSD radix (tile from the far end of the block's heading, then id);
  the movement writes the rows' positions where it writes the footprint records; occ.offsets come from the
  blocks' row counts (occ_prepare / occ_block_counts, leader_dir, row_live, tile_range deleted). A row is
  one a live unit and holds only what is exact when read: x, y, slot, id, radius | layer | footprint, owner
  (the stats row and the navigation profile were dropped again: kernels write them without marks; they
  come back with the step, whose job is then their reader). Speed: parity (k89 wall 24.9 / 33.5-36 ms a
  step at dk 1 / 4 against 22.5-24.8 / 32-33.5; step p50 within run variance), plus 4.2 ms a step of
  serial mvt_sync at dk 4 (11k marked rows a step) on the simulation thread: to the helpers with the next
  part. Details in OPTIMIZATION_PROGRESS.md; data in tests/test-runs/move-occ-stage3b-20261112/.
- **Stage 3b, second part done** (outcome-identical: the same position hash as the first part): the
  table's sync off the simulation thread (its scan in kernel 8's slot chunks, a small plan, the block pass on
  the helpers between the two stages: 4.2 ms serial -> ~0.5 ms serial + a short dispatch); the first stage's
  marks as a bit a slot and its results as one word beside the footprint (the block job reads no class /
  flags / profile / output columns for a unit it resolves); the job's chunk cache made at its first swap
  look. Measured effect on kernel 89: small (~-10 ms of ~325 ms helper CPU a step at dk 4): its time is not
  in those columns. What is left of it: footprint sweeps ~95 ms, the resolve's arithmetic and its position /
  steer-record lines ~55, the gather, order and second pass ~45, swaps ~28, epilogue ~22.
- **The resolve as a cell walk (3.2 step 3), tried and not kept** (2026-11-13; the code is in
  tests/test-runs/move-occ-stage3b-20261112/walk-resolve-not-kept.*.rs): cell steps against one window word,
  wanted move / slides / shoulders by masks, on the present row-major bitmap. Kernel 89 322 -> 294-304 ms
  helper CPU a step at dk 4 (the walk itself 91-101 ms, what the sweeps cost), a dense march +5% progress,
  two crowds head-on at dk 4 -5.5%, tests/traffic-pressure failing (90% of the units moving, 95 asked).
  Ruled out as the walk's cost, each by a build: the rows read a cell step (kept as 64-bit words over the
  walk: no change), the rows outside the footprint's reach (no change), cold bitmap lines (read up front
  a job: 10 ms spent, 8 saved). 250k walks a step make 935k cell iterations at ~100 ns: the next thing to
  measure is the iteration's own arithmetic (the reach test's 64-bit products, the per-walk divisions in
  the row's block test) with the loop split into profiled pieces, before another attempt. Section 2's
  63-87 ns a unit came from one thread on a bitmap that stayed in L1: it does not carry over as it is.
- **The step from rows, sized (2026-11-13), not started**: kernel 8's steady step is ~35 of its 114 ms helper
  CPU, ~3 ms of the step's wall; it is bound by its checks (steer record, flow field, energy, floor), not by
  memory, so rows only help once those checks are events (stage 4). Meanwhile a third of the step (50 ms) is
  serial work on the simulation thread: see OPTIMIZATION_PROGRESS.md, the last entry.
- **Stage 3b, left**: the step from the rows (target, speed, class, due in the row; kernel 8's intent mode
  replaced: 115 ms) needs stage 4's events first (above); the resolve needs the walk's cost understood first (above)
  and the head-on case kept. The block pass of the sync could ride in kernel 89's jobs (needs a rule for a
  neighbour's swap partner whose row is not in yet). Then 3c.
- Stages 0, 3c, 4, 5, 6: not started. The numbers of section 1 are the state before stage 1.

## 1. Measured now

Scene `tests/scenes/chaos-1m-250k.gz`, Node 24, wasm32, 8 real helpers, 15
warm-up steps, 30 measured. 484,141 units with a footprint (299,899 walking
a flow, 179,241 parked). Footprints: 1x1, 3x3, 5x5 cells only.

Helper CPU a step, by kernel family (share of all helper busy time):

| | dk 1 | dk 4 |
|---|---|---|
| `mv_move_occupancy` (89) | 246 ms (24%) | 321 ms (20%) |
| steering looks (`mv_flow_*`) | 169 ms (16.5%) | 281 ms (17.5%) |
| `mv_move` (8) | 113 ms (11%) | 132 ms (8%) |
| traffic + occupancy counts | 17 ms (1.7%) | 26 ms (1.6%) |
| **movement, all of it** | **545 ms (53%)** | **760 ms (47%)** |
| acquisition (`k_acq*`) | 57 ms (5.6%) | 208 ms (13%) |
| worker search (`k_ws*`) | 33 ms (3.2%) | 127 ms (7.9%) |
| visibility (`k_vis*`) | 29 ms (2.9%) | 93 ms (5.8%) |
| navigation builds | 41 ms (4.0%) | 75 ms (4.7%) |
| index, relayout, status, stats, slot zeroing | 132 ms (13%) | 82 ms (5%) |
| all helpers | 1,023 ms | 1,606 ms |
| step p50 / p95 / max | 129 / 159 / 209 ms | 197 / 252 / 258 ms |

Events a step (debug counters, no helpers):

| | dk 1 | dk 4 |
|---|---|---|
| units resolved against the bitmap | 189k | 194k |
| footprint tests / `motion` calls | 491k / 633k | 1,193k / 780k |
| shoulder searches / previews | 72k / 145k | 121k / 245k |
| fully blocked at the end | 161 | 996 |
| swap looks / swaps done | 38k / 748 | 45k / 1,345 |
| yields called / moved | 56k / 34k | 77k / 51k |
| epilogue slots (tile changes) | 30k | 101k |
| kernel 8 lanes: four at a time / one by one | 539k / 308k | 341k / 387k |
| `step4` lanes done (of 300k walkers) | ~60k | ~10k |
| `move_flow` calls / steers in the last steer's tile | 48k / 20k | 150k / 68k |
| exact looks computed | 27k | 71k |

Per unit and step, today: **740 ns (dk 1) to 940 ns (dk 4)** of helper CPU
for kernels 8 + 89, 1,130-1,570 ns with the steering looks.

Why (the findings the design rests on):

1. **Scattered columns.** A unit has ~240 columns; the movement reads 15-40
   of them a unit a step. Kernel 89 reaches units through the tile index
   (spatial order): 15-20 missed lines a resolved unit. Kernel 8 walks slots
   in order but over 40-odd streams, and only 15% of units stand in their
   slab's block, so its tile-indexed reads miss too: even its "vector"
   paths cost 150-300 ns a finished lane (`step4` 18.7 ms for ~60k lanes,
   `combat4` 18.6 ms for 76k).
2. **The whole unit is too big to keep in spatial order** (the relayout
   moves ~240 columns a unit at 1.3 us; armies outrun it). A 40-byte
   movement row is not.
3. **The same footprint test many times.** Diagonal, x, y, four shoulders,
   each a swept test at dk 4; yet nearly every unit ends up moving.
4. **Tick-based windows collapse when dk > 1**, which is exactly when the
   game is slow. The steer window is 16 base ticks (4 near the destination):
   4 steps (1 step) at dk 4. `SIM_FLOW_REFRESH_TICKS` is 4: at dk 4 `refresh`
   is true on every step for every steer. A diverted unit loses its steady
   window at once. Result: `step4` finishes ~10k of 300k walkers, 150k
   `move_flow` calls a step (45% of them in the tile of the last steer),
   71k exact looks a step (281 ms).
5. **Per-job fixed work is O(block area)** (~29 ms a step), **97% of swap
   looks find nothing**, and the tail of `simMoveRun` loops over listed
   slots in JavaScript.

## 2. Prototype: what the hardware allows

`tests/test-runs/move-occ-plan-20261112/mvproto/` (Rust, wasm32 + simd128,
one thread, Node): 483,960 units in 60 armies walking at each other in
pairs until they jam, 1x1 / 3x3 / 5x5 footprints on an 8192x8192-cell
bitmap, **every unit walking** (the scene has 300k of 484k). The design of
section 3 for the hot path: block-ordered rows, a four-lane step toward a
target point, LSD radix order (position along the heading, id), window
word + preference table per cell step, positions published to slot
columns, rows re-homed when they change block. No walls, pushes, swaps,
steering or combat: the floor of the hot path.

| part | dk 1 | dk 4 |
|---|---|---|
| step toward the target, 4 lanes | 3.4 ns a unit | 3.4 |
| + order (3 radix passes a block) | 17 | 17 |
| + resolve (214k / 394k crossers, 45k / 200k diverted) | 63 | 87 |
| + publish to slot columns (in block order) | 69 | 97 |
| ... slots shuffled (the worst case for publishing) | 79 | 109 |
| **a step, one thread** | **33 ms** | **47 ms** |

Bits in the bitmap are conserved over the run (no footprint lost or
doubled). So the hot path costs 70-110 ns a walking unit against 740-940
today, without any tuning of the resolve loop (~100 ns a crossing unit: the
bitmap's rows are 1 KB apart; see 3.6).

## 3. The design

### 3.1 The mover table

A static table in the wasm heap (allocated at match start from the slot
capacity), one row a unit with a footprint, **kept in block order**: a
16x16-tile block owns slabs of 64 rows, SoA inside a slab, so four
consecutive rows load as vectors.

```
x, y        i32 x2   position, Q8 (the working copy; unit.x / y are published from it)
tx, ty      i32 x2   target point, Q8 (the steer's; a chase's target; a push's)
slot, id    u32 x2   the unit's slot (publishing, events) and id (order, tick hashes)
due         i32      next step this row needs the cold path (wake, shot, look's end, check)
spd         u16      stats row index: speed from the hot stats table (L1), not copied a unit
cls, flags  u8 x2    class (idle, parked, walk, hold, chase, yield) and bits (flying, worker, frozen...)
meta        u16      radius 2 | layer 2 | team 7 | wall profile 2 | hand 1
rte         i32      route end (the swap's crowd rule, arrival)
```

~38 bytes a row: the scene's whole movement state is 18 MB (fits the
shared cache), a block's rows a few KB (L1 for its job). Pool: capacity
rows + one open slab a block (4096 x 64 rows of slack).

- A row changes block when its unit does (1.6-6k rows a step in the
  prototype): 38 bytes copied to the new block's open slab, the hole filled
  by the block's last row, `unit.hrow[slot]` updated. Listed by the block
  jobs, applied by one small kernel after the phases.
- The unit columns stay the truth for everything that is not stepped every
  step (orders, routes, stats, combat state). A row is a **cache with one
  rule**: whoever writes a movement-relevant column of a unit sets
  `unit.mvDirty[slot]`; a pre-pass over the dirty bytes (a 16-byte compare
  a time) rebuilds those rows. Research changing a speed dirties nothing:
  rows hold the stats row index.
- Restore and resync rebuild the table from the columns. Because the block
  job orders rows by (position, id), the table's row order never shows in
  outcomes: a restored peer with another row or slot layout computes the
  same step.
- Safety net: `k_mvt_audit` recomputes every row from the columns and
  compares; run every step in the determinism tests and behind a query
  flag in Edge. A missed dirty mark is then a test failure, not a desync
  found in play.

### 3.2 One job a block: step, order, resolve, publish

Four colour phases as today (a block and its halo are one thread's); a
claim takes a run of blocks. Per block, all from the block's rows:

1. **Step, four rows at a time, every class at once by masks** (f32
   simd128, exact operations only: subtract, multiply, divide, sqrt,
   nearest): walkers and chasers head for (tx, ty) at their speed x dk,
   stopping at it; the pressure sample and its sideways bend
   (`keep_right`, the cap) added; pushed standing rows get their push
   response as the step. Idle and parked lanes cost the masked arithmetic
   (3.4 ns) and nothing else. `due <= now` and "reached the target's
   tile" set the row's event bit.
2. **Order:** LSD radix (8-bit passes) on position along the block's
   heading, then id. The heading is the integer sum of the wanted steps
   (the same in any order). Passes whose digit is constant are skipped.
3. **Resolve, integers only.** A step inside its cell is done. Else per
   cell step: the window word (the 2r+1 rows around the footprint into
   one u64, own cells cleared), the wanted direction's fringe mask first,
   and only when that is taken the other seven and `PREF[d][hand]`: d,
   d+-1 (the slide), d+-2 (the shoulders), hand side first. Steps of
   several cells repeat it within the halo limit. Walls: the block's wall
   bits a profile (one bit a tile with a ring, 41 bytes) and one bit test
   at a tile change. Pressure deposits, the push record ahead when blocked
   more than 30%, the swap (only where a summary byte a tile says a
   swappable unit of the mover's team stands: section 1 point 5), the
   walker's second pass by a flag. Fully as rev 2 section 2.2, but reading
   rows, not records.
4. **Publish:** x, y (and the previous position, velocity where a consumer
   needs them) to the slot columns; rows that changed tile, block or need
   the cold path into the job's event list.

`mv_move`'s intent mode, `mark_need`, the need byte, `occ.work`, the index
visit loop, `leader_dir`, `cache_chunks`, `resolve_slot`,
`checked_traffic_q`, `preview` / `motion` / `horizontal_motion` /
`commit_preview` / `free_special` and the r2 / r3 leaves, `step4`,
`park4`, `idle4`, `walker_short_at`, `yield_tag` go. The generic `free` /
`clear_or_mark` stay for spawns, teleports and larger radii.

### 3.3 The cold path: events, not a scan

What is left of `mv.rs`'s per-unit logic runs only for rows that raised an
event, from the block jobs' lists (a parallel pass after the phases; it
writes the unit's own columns and its row):

- **Steering by look, not by ticks.** A steer writes a target point (the
  look's far tile and side offset) valid until the unit reaches it, leaves
  the look's corridor, or the look's wall key changes. Being diverted does
  not end it: the unit heads for the same point from where it is. The next
  look is requested a few tiles before the far tile, so the exact-look
  lane's one step of delay is hidden. `SIM_STEER_TICKS`,
  `SIM_STEER_NEAR_TICKS` and `SIM_FLOW_REFRESH_TICKS` go (the refresh
  becomes the wall key and the corridor test). Steers a step: from 150k
  (dk 4) to the units finishing a look; exact looks fall with them (they
  are made per steer).
- **Timed things on wheels** (static buckets by step, sized at match
  start): a parked unit's wake, a hold's next shot, a worker's check tick,
  the floor's once-a-second look, staggered by id as today. A row's `due`
  is its wheel entry's mirror: the hot loop never tests modulo ticks.
- **Combat:** hold = class hold (stands; its shot from the wheel); chase =
  class chase with the target's row index in the row, its target point
  read from the target's row each step (one load); the brain's other
  instructions through the event list as today's `move_combat`.
- **Epilogue** for rows that changed tile: index key, area, charges, in a
  batch per block (the block's tiles' index entries are near each other),
  entirely in the kernel. The JS loops at the end of `simMoveRun`
  (`spatialSlotUpdate` a slot, `occupancyAfterMovement`,
  `_simMoveSepListed`) go; the simulation thread gets a short list of real
  events (a unit in a wall tile, an area box to make, a budget mark).

### 3.4 Determinism

- No float sums across units; per-unit float math uses exact operations
  on values that are the same on every peer (no fused multiply-add, no
  relaxed SIMD).
- Order inside a block from (position, id); between blocks from the fixed
  colour phases.
- Cross-thread accumulations are integer atomic adds / ORs with clamped
  contributions (pressure, swap summary, push bits).
- The table is derived state: rebuilt at restore, audited against the
  columns, never hashed itself.

### 3.5 Threads

- A claim = a run of same-colour blocks, heaviest first as today; with
  jobs this light the four barriers (~1 ms) and claim overhead matter:
  blocks with no moving row are not listed at all.
- Events and row re-homing are parallel by block; the pre-pass over dirty
  bytes by slot chunk.
- Helper count stays as tuned (8 on 16 threads): the machine is already
  full; the gain is less work, which also frees helper time for the
  background lanes whose commits the step waits for.

### 3.6 The bitmap as one u64 a tile

8 sub-cells a tile: a tile's occupancy is exactly a u64. Tile words in
block-major order put a block's bitmap in 2 KB (today its 128 rows are
1 KB apart) and a window in at most four words. The prototype's resolve
is ~100 ns a crossing unit with the row layout: measure the tile-word
layout in the prototype first; adopt it if it gives 1.5x or more on the
resolve. Touches `occ_shapes.rs`, `traffic_capture`, births, release.

### Considered and not taken

- **Requests rebuilt every step from the columns** (rev 2): still walks
  40 column streams a unit a step; the persistent table replaces it.
- **Keeping whole units in block order** (a faster relayout): 240 columns
  a unit; the table gets the locality for 38 bytes.
- **Order-free claims** instead of ordered block jobs: followers cannot
  enter the cell a leader leaves in the same step; columns move in waves.
- **Remembering blocked units:** under 1,000 a step end blocked.
- **An owner id a cell:** 256 MB at this map.

## 4. Expected effect

Helper CPU a step at dk 4 (dk 1 in brackets). Hot path from the prototype
(300k walkers of 484k rows, plus walls, pressure, pushes, swaps on top);
the rest estimated from today's per-call costs and the expected counts.

| | now | after |
|---|---|---|
| block jobs: step, order, resolve, publish | 453 (359) for kernels 8 + 89 | 35-55 (25-40) |
| dirty pre-pass, row re-homing | - | 3-6 |
| cold path: steers | in the above | 7-15 |
| cold path: combat, shots, wakes, checks | in the above | 8-15 |
| epilogue, index (and the JS tail) | in the above + serial | 10-15 |
| **kernels 8 + 89** | **453 (359)** | **65-105 (50-85): 4-7x** |
| steering looks | 281 (169) | 60-120 (50-90): 2-4x |
| traffic, counts | 26 (17) | 15-20 |
| **movement, all of it** | **760 (545)** | **140-245 (115-195): 3-5x** |

What that is worth for the step: movement is 47-53% of helper CPU, so
3-5x on it is **1.5-1.7x on the helpers' total** (1,606 -> ~1,000-1,100 ms
at dk 4), more on slow steps (movement is what grows on them) and more
again once the lower cost lets dk fall (dk 1 has far fewer looks, tile
changes and acquisition work a step). Movement alone cannot give more than
~2x on the whole step. The next multipliers are acquisition (13% at dk 4),
the worker search (8%), visibility (6%): all three scan positions, team
and radius around a point, which is what the block-ordered rows hold; the
table is the base for converting them the same way (section 7).

## 5. Implementation stages

Each stage is complete (no JS path, no second path kept), builds with
`node wasm/build.cjs`, and gets sanity checks; full regression and perf
after stages 2, 4 and 6.

**Stage 0: counters and the prototype's open questions (1-2 sessions).**
Kernel 8 by lane class (who goes scalar and why at dk 1 and dk 4), looks:
length, how a look ends (reached, corridor left, wall key, refresh),
steers per walker per tile; events a step that the cold path would see.
In the prototype: tile-word bitmap (3.6), walls, pressure and pushes
added, 8 threads with the colour phases. These fix the numbers of
section 4 before the big change.

**Stage 1: windows by step and by look (small, large at dk > 1).**
`refresh` and the steer windows no longer tied to base ticks: steer by
target point with look validity (3.3, first bullet), in the current
kernels. Expected: `move_flow` calls and exact looks at dk 4 down by more
than half, `step4` taking most walkers again. This is the cheapest large
gain and independent of the table.

**Stage 2: the resolve (window word, preference table, cell steps).**
In the current stage structure, radius <= 3, any dk; the old sweep code
for those radii deleted; per-job fixed work fixed. Behaviour changes here:
judged on the flow benches before anything is built on it.

**Stage 3: the mover table.**
3a. Table, slabs, `hrow`, `mvDirty` marks at every writer, the dirty
pre-pass, re-homing, rebuild at restore, `k_mvt_audit` in the tests.
Nothing reads rows yet: the audit proves the marks complete (run the full
functional suite with it on).
3b. The block job (3.2) replaces kernels 8 (intent mode) and 89 for
walkers, parked, idle, pushed standing units; events to the existing
scalar logic as the cold pass.
3c. The old paths deleted (list in 3.2).

**Stage 4: the cold path as events.**
Wheels for wakes, shots, checks; hold / chase classes; the epilogue and
index updates in block batches; `simMoveRun`'s JS tail reduced to the
event list.

**Stage 5: tile-word bitmap** (if stage 0 measured it worth it).

**Stage 6: measure in play, tune.**
Headed Edge, multiplayer, the 1M and 4M scenes; helper count and claim
size; dk falling back toward 1.

## 6. Checks

- Determinism: `chaos-scenario-determinism`, `multiplayer-chaos-determinism`
  (also `SIM_WORKER=1`; 0 / 3 / 8 helpers equal), `lockstep-hash-stream`,
  `deterministic-sort`, restore-then-continue on two peers. New: the table
  audit every step; a test that permutes row order inside blocks, slab
  assignment and slot layout on one peer and expects equal hashes; a
  cross-engine run (perturbed Node math) over the block job's float code.
- Behaviour (numbers, not hashes): `traffic-pressure` (`maxSpeedRatio`
  < 1.01 stays strict), `rally-pulse.bench` (pulse, `--walker`,
  `--leaver`), `crowd-flow.bench`, `stuck-flow.bench` (4M; net progress
  within a few percent or better), the crowd-scenarios runner,
  `worker-approach-occupancy`, `occupancy-grid`, `occupancy-shapes`,
  `occupancyAudit()`. Position-exact assertions re-based once these hold.
- Performance, serially: `occ-sched-probe` at `DK=1` and `DK=4` with
  `PROF=`, the counter probe, `chaos-spikes.bench` (p95 / p99 / max,
  slow-step attribution with previous / slow / next tick), headed Edge
  (`scene_tps_probe`, `simtrace-spikes`, three runs a variant),
  multiplayer.
- `OPTIMIZATION_PROGRESS.md` after each stage.

## 7. After this plan

The rows (position, team, radius, class, in block order, 18 MB for the
scene) are what the other large consumers scan: acquisition samples and
snapshots, the worker search's near fields, visibility seeds, the combat
scan. Reading them from the table instead of index -> slot -> columns is
the same change as this plan's, for the next 25% of helper CPU.

## 8. Risks and open points

- **The dirty rule** is the plan's main correctness risk: many writers
  (kernels and JS) change movement-relevant columns. Mitigation: stage 3a
  ships the marks and the audit alone, with every test running the audit,
  before any behaviour depends on rows.
- **Flow quality** with the preference table and with steering by target
  (units converge on the look's point from wherever they were diverted):
  stage 1 and 2 each change one of them and are judged on the benches
  separately.
- **A step of delay** between a row's event and the cold path's answer
  (a new look's target): hidden by asking early (3.3); arrival and stops
  are decided in the hot loop (reached the target), so nobody overshoots.
- **Reads of unit.x / y during the phases** see published positions of
  finished blocks and old ones of the rest; today's second stage has the
  same property. Anything needing the step's start reads x0 / y0.
- **Halo:** the cell-step loop keeps `blockq/2 - (r+32)*cell` per cell
  step, as the sweep did per target.
- **Memory:** ~38 bytes a slot of capacity plus 10 MB of slab slack
  (160 MB at 4M slots), static, inside the 4 GiB budget; `occ.work`, the
  need marks and the steering windows' columns come back.
- **Numbers:** the hot path is measured (prototype), the cold path and the
  looks are estimates until stage 0's counters; the 4-7x on kernels 8 + 89
  stands or falls with how many rows raise events a step.
