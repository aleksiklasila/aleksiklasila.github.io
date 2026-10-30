# Serial work off the main simulation thread

Goal (user, 2026-10-29): the main simulation path O(things / threads):
everything that scales with counts (units, structures, projectiles,
deaths, order sizes) as wasm kernels (SIMD, SoA tables, static tables),
run as parallel tick jobs or tier lanes committed at fixed ticks; the
main thread dispatches and applies in O(1). Not the small things that
never take time. Same direction as the movement kernels (simMoveRun) and
BRAIN_OFF_MAIN_THREAD_PLAN.md (whose target architecture still holds:
columns are the state, objects are views). Work in batches; measure each
batch before regression-testing it.

Design rules (user, 2026-10-29):
- Everything above to wasm kernels; nothing that scales stays in JavaScript.
- Statuses may lag a few ticks: a helper job, its result taken by an O(1)
  flip at a fixed tick.
- Worker search is a brain (helper lane), not main-thread work.
- Structure hits are not different from unit hits: one hit path.
- Dead units as dead buildings: a dead flag / energy <= 0 on the row, no
  per-unit detach copy.
- Expensive maintenance passes (unit slot compaction and the like) go
  away: static preallocated arrays sized at match start.
- Prefer "flip switch" commits: helpers make the next state, the
  simulation thread switches to it in O(1).
- Only player input -> feedback (mouse, keyboard) is lag sensitive. Statuses
  and the rest are off the critical path: approximate them freely, as long
  as it is fair to the players and accurate on average.
- No JS arrays or objects for simulation state, growing ones least of all
  (lists, Maps, free lists, dirty lists, tables of object references): wasm
  heap typed tables sized at the match's start, ids instead of references,
  counts in heap words, kernels and SIMD over them. GC pauses are spikes.
- Pack the flip state with SoA and bitpacking (parity bits, small codes,
  quantized fields) to save space.

## Where the main thread goes (2026-10-29)

Scene: `tests/chaos-spikes.bench.cjs --units=1000000 --structures=250000
--rally-mix --helpers=11 --dk=1 --kernels --burst-every=100000 --mass-at=30
--ticks=60 --profile --profile-start=20 --profile-interval=1000`; steady
steps 38-59 (~370k units alive, ~2,500 unit deaths a tick, ~20k
projectiles). Tool: `node tests/profile-serial-share.cjs run.json
--from=38` (JavaScript is serial: helpers run wasm only). Evidence:
`tests/test-runs/mass-command-20261029/serial-profile.*`.

Sampled ~294 ms a tick: ~200 ms JavaScript, ~80 ms wasm (mostly this
thread's share of the movement kernel), ~11 ms GC.

| area | serial JS ms/tick | what (top functions) |
| --- | ---: | --- |
| deaths / retire | ~30 | simUnitStateCollect detach (21: generated copy of every column into `_det`, ~8.5 us a unit), removeUnitSpatial 2.7, compactRemovedUnits 2, workers' target release at death 1.1, upkeep, order queue |
| worker search tier | 23 | _wsGroupBuild 4.8, spawner lookups (_getWorkerSpawnersByType, _ownedSpawnersOfType), structure derived fields |
| structure hits | 22 | _structHitsApply 2.4, _unitHitBuilding, destroyBuilding, clearTileEntity, derived fields |
| status effects | ~17 | tickStatusEffects 7.4, thingStatusDue 6.8 (untimed, in the tick body), statusPrepassRun 1.9 |
| projectiles | 15 | projectilesAdvanceNative 6 (JS around the kernel), hit callbacks |
| spawner structures | 13 | spawnerStructuresTick 4, research advance, statuses |
| movement glue | 13 | simParallelRun waits, trap units bound 1.5, traffic/occupancy job setup |
| towers | 12 | towersTick 2.5, _towerApplyPrepared 1.3, Projectile objects |
| adjacency | 11 | adjacencyLaneStep 1.9, _adjApplyMember 1.1, stationaryBrainChanged |
| unit events | 10 | lane waits, updateWorkerAI, path regions |
| tick body, accessors | ~12 | _gameTickBody self 5.7, getCellItemsRowMajor 2.9; generated accessors (`(anonymous):2`) ~25 ms spread over every phase |
| visibility, regions, effective levels, lasers | ~12 | |

Click ticks (the mass command: 185k units, 78k rally buildings) add
~150 ms: rally tiles 17 (JS per building), id decode 12 (JS), admission,
the queued orders' JavaScript part (group/flow order JS, workers' task
release: _clearWorkerTarget, task memory, setters, digest terms: ~60 ms
on the last drain tick).

## Batches

1. **Orders.** Ids decoded and joined by kernels (lane or parallel tick
   job), the whole order applied at its commit tick by the parallel order
   move kernel (no ring, no drain); rally tiles applied by a kernel over
   the structure tables; workers' manual-move release as a kernel (worker
   state, next retarget tick, workerTarget / type / reservation index as
   columns with digest terms; reservation table numeric; task memory as
   worker sidecar columns). Units the kernel cannot take (pending ways,
   path windows) given kernel paths too.
2. **Deaths.** No per-unit detach copy (a dead unit's object reads its
   quarantined slot until the slot is reused; references by slot + id);
   spatial removal, upkeep, order and worker release in the retire kernel.
3. **Statuses and structure hits.** Status records ticked by a kernel over
   the status side table (units and structures); structure hits applied
   by a kernel over the structure tables, destroys batched.
4. **Worker search tier and unit events.** The lane's inputs and outputs
   as columns (spawner lists by type and owner as tables), worker AI steps
   as kernels.
5. **Projectiles, towers, spawners, adjacency.** Projectile pool columns
   (no Projectile objects), tower apply in the kernel, spawner/research
   ticks over structure tables, adjacency members as table jobs.
6. **Glue.** Accessor-heavy loops replaced by column reads; tick body
   untimed work timed and moved.

## Batch 1 design: workers' move orders in a kernel

What a worker's move order writes today (main.js _ordClearFast,
_ordWorkerManual, _issueFlowOrder) and where it goes:
- `workerState` (JS string, jr__ws): a u8 code column in the heap; the
  accessor maps code <-> name (a fixed table, so the JavaScript that compares
  names keeps working); digest term per code precomputed.
- `_workerNextIdleRetargetTick` (jr__wnr): an Int32 heap column (undefined a
  sentinel); its digest term is the value.
- `pathIsFallbackAstar`, `_pendingPathTarget`, `workerTarget`,
  `workerTargetType`, `_workerReservedTileIndex` (JS reference arrays): a
  per-slot "set to the order's default" bit column the kernel writes; the
  accessors read the default while the bit is set, a setter clears it. Their
  digest: one Int32 column per slot with the sum of those fields' terms,
  kept by the setters, so the kernel moves hObj by (defaults' sum - it).
- The target's tile and the reservation index the release needs: mirrors
  (heap Int32) kept by the setters' hooks; a unit target's position from the
  id index.
- Reservations (workerReservedTiles, objects): a heap Int32 table of unit
  ids, with the region counts and digests in the heap; the ~10 readers by id.
- Work versions (workerWorkChanged): already a heap table; the kernel bumps
  it and returns the checksum's change.
- Task memory (role fields, one object a unit): a per-slot pending-clear
  column (the order's tick + 1); the role accessors apply the clear on first
  use (same values as the eager clear; deterministic, in snapshots by value).
- Path: workers follow the order's flow like the kernel's units (nvPK,
  pathIndex 0), no shared path object.

## Batch 2 design: deaths

A death is the dead flag in its slot, nothing else: no detach copy, no
collect sweep, no compaction (user: if the issue is JavaScript, convert it to
wasm; no fallbacks just for JavaScript). That needs every cross-tick holder of
unit objects in the simulation converted to heap tables of slot + id first:

| holder | where | to |
| --- | --- | --- |
| pending-path units (Set, Map tick -> lists, pools) | pathfinding.js | heap timing wheel of slot + id by due tick |
| worker conflict index (_workersWithTarget, _workerConflictEntries) | worker.js | heap table by target tile |
| healers' damaged-unit candidates (per-owner object lists) | worker.js | heap id lists per owner, built by a kernel |
| attackTarget (JS reference field) | unit state, presentation | id column |
| _tuPending (targets decoded before their slot) | unit.js, restores | id resolve at decode end |
| _displayPaths (Map unit -> path) | pathfinding.js, display | page side |
| units list, id map | everywhere | slot list + heap id index (unitIdIndex) |

Per-tick temporary lists of units (out.push(u)) hold nothing across ticks
but are garbage every tick: heap scratch as each phase becomes a kernel.

Interim (2026-10-29): retired units are detached at their removal's tick on
every peer (main.js compactRemovedUnits), copying only the typed columns
and a few references (SIM_UNIT_DET_SKIP); goes away with the above.

## Batch 4 design: the worker brain

Measured spike: the worker search tier's post every 4 ticks (55-83 ms at
~370k units), almost all `_wsGroupBuild` and the structure accessors under
it: the collectors' target groups rebuilt as JS lists of drop, mine, farm and
spawner objects whenever any input changed (drops change every cycle in a
battle). Order of conversion:
1. Drops: a heap per-tile table (type, value, timer, owner) and a heap list
   (index column); drop objects views. (Today: objects, a JS 2D grid, per-area
   JS bucket lists, a JS list; made and dropped per kill: GC.)
2. The collectors' groups by a kernel from the structure tables (rows: type,
   owner, energy, under construction, mine values) and the drop table: heap
   tile lists the search kernels read; spawners likewise.
   Plan for step 2: drops never appear in play now (nothing calls
   addDroppedItem; only old snapshots carry them), the rebuilds come from the
   farm/mine/spawner lists changing (any placement or destruction of that
   type). The per-tile table `_ST` already has, per tile, the class code,
   owner, under construction, value (energy; a mine's amount) and the
   stationary descriptor (`brain`: type id in its low 16 bits, peer-local
   ids from `_stationaryTypeIds`). A kernel scans the tiles in row chunks
   (parallel, empty tiles skipped by SIMD), per group: the mines of its kind
   with value > 0, its farms (type id, energy > 0; under construction
   WS_NOT_BUILT), its spawners (their class code, energy > 0), into the
   group's existing arrays (wsg{id}.sx/sy/st/so/sready, the buckets bs/bc/bi,
   spawners pgx/pgy/po/pid/px/py/pready, meta) plus a tile list
   (wsg{id}.tile) in place of G.objs/G.types; chunk counts merged by prefix
   sums so the order is tile order on every peer (rows are laid out per peer:
   never order by row). The take resolves its few results' tiles to objects.
   _wsNearField's spawner hash from the arrays.
3. The search take by tile (results resolved to objects only where JS still
   reads them), then no objects.
4. The worker trips (gather, deposit, build, heal, research, salvage) as brain
   kernels over the worker columns (wkS/wkT/...), the conflict index and the
   healers' candidates as heap tables; worker.js's per-unit JavaScript gone.

## Batch 3 design: structure statuses

Today (renderer.js 7476-7560, main.js ~667, barrack.js thingStatusTickSelf):
two JS Sets of structure objects (_thingStatusActive, _thingStatusSelf),
sorted copies each tick (thingStatusDue: Array.from + sort), and a JS tick
per structure (tickStatusEffects: timers burning/poisoned/frozen/wet/sandy/
watched, tick damages to energy, damage visuals, shrine income, the watch's
end to the visibility cover). The fields are already heap row columns
(_STF_BUILDING: burning, burnTickDamage, poisoned, poisonTickDamage, frozen,
iceTickDamage, wet, sandy, watched, watchedByTeam, _en). To do: a kernel
over each structure table's rows in the world (row `_stT` >= 0; parallel
row chunks): timers down by simDk, damage applied, a structure's lost
energy into per-owner fixed-point shrine sums (integers: order-free; as
data_dynamic.js shrineDamageTaken / _toFixedResourceUnits), out lists (in
tile order) of those that ran out of energy (the destroy path), whose watch
ended (visibility cover) and that took damage (damage visuals: page side).
The Sets go; statuses may lag a few ticks (a lane job flipped in O(1) is
allowed: user).

## Batch 5 design: projectiles

Today (projectile.js): `projectiles`, a JS array of Projectile objects (~20k
in a battle, one object a shot: GC); the flight kernel (k_proj_flight)
already flies them, but each step copies every object into the `pj.*` heap
arrays and back (projectilesAdvanceNative, ~6 ms) and applies hits through
JS callbacks (p.hit / p.hitBuilding: unit damage, blast, structure damage).
To do: the `pj.*` arrays (x, y, vx, vy, life, start, range, owner, floor
target, damage, level, type, blast) are the projectiles: a heap pool sized
at match start, a slot a shot (free list a heap stack), towers write a slot
where they made an object; the kernel's events feed the unit-hit queue
(unit targets) and k_struct_hits' list (structures) directly; blast as a
kernel over the spatial index; the presentation's projectile records and
the snapshot's `p` list from the pool (encode/decode, hash fields); no
Projectile objects. Then towers (towersTick), spawners and adjacency the
same way: their per-structure JavaScript into kernels over the tables.

As built (2026-10-29, rules revision 51):
- The pool (projectile.js): `pj.*` columns by slot, PROJ_POOL_CAP = 2^17
  (allocated once; a shot past it is not made, counted in `pj.hdr[3]`, the
  same on every peer), `pj.live` the slots in flight, `pj.free` a stack,
  `pj.hdr` the counts and the next shot id. Towers call `projectileFire`
  (one slot written; their stats' status duration / dps for the type
  resolved there: pj.sd / pj.sp).
- No result depends on a shot's slot (a restored peer lays them out
  differently): unit hits are sums, structure hits go in shot-id order, the
  hash is a sum over the shots (k_proj_hash), the snapshot's `p` records are
  made in id order with the next id.
- A step: k_proj_flight (helpers; writes x, y, life, the step's start for
  interpolation and the event in place), k_proj_resolve (direct: live list
  compacted, spent slots onto the free stack, hit lists `pj.uev` / `pj.sev`,
  the first 256 looks), k_proj_struct_hits (direct, ord.rs: the same
  `SCtx::hit` as the units' k_struct_hits; sand statuses on structures now
  too). Unit hits wait for unitHitsResolve: k_proj_blast counts the blasts'
  reach first (room for touched units and fire's status records, so no
  overflow can depend on thread timing), then k_hits takes the shots as a
  third job kind (shot_hit: the type's statuses with their durations and
  tick damage, resistances and tower immunity by unit type flags `pj.tfl`;
  the blast over the unit index). A freed slot's columns stay until a new
  shot takes it, which is never before the step's hits are applied.
- Behaviour changes: a shot's unit hit lands with the unit hits after the
  movement kernel (it did before it); a shot whose unit died earlier in the
  step is spent (it flew on); a structure with custom stats or position is
  hit at its tile's centre (the flight went to JavaScript for it); sand
  statuses on units from shots (stSa) and on structures; elements on
  structures use the default durations.
- JS left per step: the looks of up to 256 hits (fx, sounds), the struct
  hits' looks/watch cover/destroys, the presentation encoders' loop over the
  live list (typed arrays).

Towers as built (2026-10-29, rules revision 52): no JavaScript turns at all.
- Due: k_tower_due over the tower table's rows (now > ceil(st.tim)); the
  JS due wheel (Map of tower lists), its sort and the tile-order radix
  kernel are gone (nothing after depends on the order: shot ids are
  (tick & 1023) << 22 | tile).
- Targets: the prepare / coarse / pack / scan / struct kernels as before;
  a reach past the table's (an area's need, the depth) uses the table's
  for now and asks for a deeper one; custom stats or position come from
  per-row heap columns (tc.*, written with the descriptor); a floor item
  without an owner takes its cell's in the tile table.
- Turns: k_tower_fire (direct): preferred targets (Tower.preferredTargetSpec
  is the row columns _ptK / _ptV: a unit by id through the unit id index,
  or a structure by tile; cleared when gone, its owner's or out of sight
  by vis.cover; out of reach: the usual target), idle cooldowns, shots
  written into the projectile pool, cooldowns (_cdUntil, st.tim), angles
  (presentation by tile slot: simPresentTowerAngles).
- The stationary reach table is double-buffered: the next one is made on
  the build lane into the other set (stb.*) and switched to when made; only
  a match's first is made at once. The legacy prepare (JS area lists), the
  scalar Tower.shoot and the JS structure searches are deleted, with the
  tests that compared the kernels with them.

## Copies (user, 2026-10-29)

No copies during play, unless impossible otherwise (once at initialization
is fine). Input from outside (a player's order off the network or the page)
needs one copy into wasm memory at most: no API receives into the heap.
Today an order's ids are a base-64 varint string: encoded into a fixed
scratch buffer (browsers' `TextEncoder.encodeInto` refuses shared memory;
Node's accepts it) and copied into the heap. To do: ids as a binary blob in
the packet, each packet copied once into a fixed heap receive buffer, the
decode kernel reading it there (no strings, no second pass, no garbage).

## Status

| batch | state | measured |
| --- | --- | --- |
| 0 (stopgap) | done: queued order units in id order (workers spread over the drain), rules revision 48 | not yet |
| 1 | started | |
| 5 (projectiles) | done: heap pool, no objects; hits through k_hits / k_proj_struct_hits; rules revision 51 | projectilesAdvance 14.9 -> 3.8 ms, unitHitsResolve 21.2 -> 12.8 ms (1M/250k scene) |
| 5 (towers) | done: due scan, turns, preferred and custom in kernels; no JS turns; rules revision 52 | towersTick 14.5 -> 7.3 ms; steady mean 224 -> 199 ms, p95 406 -> 318 (1M/250k scene) |
| 4 (search tier) | conflict index gone, spawner index + nearest kernel, groups from a candidate list; trips (updateWorkerAI), work-site sweep left | search tier 17.9 -> 10.1 ms, takes 8.8 -> 2.5 ms (1M/250k scene) |

## World model as heap tables (plan, 2026-10-29)

The worker trips, structure destruction (hits, projectiles, salvagers,
statuses), spawner ticks and visibility all go through the JavaScript world
model: grid[y][x] cell objects ({type, item, owner, areaId, droppedItem}),
tileEntityType / tileEntityRef grids, _activeTileEntities (a Set), and the
towers / barracks / collectorSpawners lists of objects. Sites (2026-10-29):
cell .item 154 in 19 files, wall tests 37, the lists ~150, tile entity
lookups ~90, _activeTileEntities 48. Stages, each complete before the next:

A. Cells as heap columns: cell type (u8), owner (i8), area (i32) per tile;
   grid[y][x] a view whose accessors read and write them (the API stays for
   the JavaScript not yet converted, as unit objects are views of their
   slots). A cell's item and tile entity: the per-tile structure table _ST
   (code, stab/rrow: class and row, rowObj) instead of reference grids. The
   region wall copy, mv.wall and the nav walls then read one column.
B. Structure lists as table rows: iteration by the tables' rows (kernels
   for anything scaling), structListPush/Remove and the object lists gone;
   _activeTileEntities from the tables.
C. Place / destroy as table operations: a destroy kernel over a batch of
   tiles (the tile table, cell columns, walls and their versions, adjacency
   dirty flags, laser dirty, counts, win check counts), events for systems
   still JavaScript (render dirty, effects, sounds: presentation events).
D. The worker trips as brain kernels over the worker columns (targets are
   tiles; payments as per-owner fixed-point sums; spawner queues and research
   tasks as columns first).

### World model, steps as built (2026-10-30)

Stage A is done (cell columns, GridCell views). The rest, each finished
before the next:

W1. Tile entities from the structure tables: per tile its table (_ST.ctab,
    1 + the table index, every tabled class incl. mines) beside st.rrow;
    getTileEntityRef = that table's rowObj[row]; getTileEntityType from st.code.
    The tileEntityRef / tileEntityType grids go (their ~30 direct reads use
    the getters); setTileEntity / clearTileEntity write only the tables, the
    journal and the hooks.
W2. _activeTileEntities (a Set, insertion order) goes: tile-order iteration
    over the per-tile table (a kernel-made list of occupied tiles, cached by
    _tileEntityVersion), so every consumer sees the same order on every peer.
W3. cell.item derived on the simulation side from the per-tile table (a
    non-tower, non-mine structure at the tile); the page keeps its own field.
W4. The towers / barracks / collectorSpawners lists: consumers over the
    tables' dense rows (order-free) or tile order (where order decides);
    the object lists go from the simulation.
W5. Place / destroy as kernels over batches of tiles (the tables, cell
    columns, walls with their versions and hooks as heap events, reservations,
    work versions, adjacency marks, the journal); JavaScript only for
    presentation events and the rows' objects.
    Destroy, done first (2026-10-30, W5a): structDestroyTiles (things_utils.js)
    over a tile list (the hit kernels' dead lists, the status tick's dead,
    destroyBuilding as a list of one), dst.rs k_struct_destroy for the tables'
    side (per-tile structure table with region and owner counts, cell owner,
    walls to ground, adjacency marks, work versions, the journal as a fixed
    heap ring, mv.struct codes and block counts, trap marks; reservations and
    wall tiles listed); JavaScript per tile: the object lists (W4), its row,
    walk-class and wall events (nav, path regions: not kernels yet) and
    presentation; versions, adjacency request, path topology and the win
    check once a batch. Left: placement as a kernel; floor items cleared by
    the status tick still go through clearTileEntity.

### Serial JS left (1M/250k scene, prof35, 2026-10-30)

Steady mean 138 ms (was 196 at the session start), p95 168. JavaScript a tick
on steps 38-59 (profile-serial-share.cjs), what each needs:
- unitHitsResolve 7.2: presentation looks (sounds, attack and damage looks,
  alerts: JS events, fine), the destroyed structures' object work
  (structListRemove: W4; structRowDetach, getTileEntityRef).
- unitEventsRun 6.9: the worker trips (updateWorkerAI, _unitWorkerEvent),
  no-way commits, nav requests; ~2 ms of it waits for kernels. Needs the
  worker state machine as kernels (stage D): targets as tiles, payments as
  per-owner sums, research tasks as columns (spawn queues are columns now).
- _gameTickBody 4.0: the retire loop's per-death reads and
  compactRemovedUnits (swap-removes in the units array, a SimUnitGone per
  death): goes with the units array (units by slot only).
- simMoveRun 5.1: mostly Atomics.wait tails (load balance), simHeapHas
  checks 0.6.
- recalculateUnitEffectiveLevel 2.8, projectilesAdvance 2.1 (stat getters on
  structures hit), towersTick 1.6 (waits), workerSearchTierStep 1.3 (13 ->
  1.3 on order ticks after k_wsw_set).
- Caps still in place: WORKER_EVENTS_PER_TICK, SPAWNS_PER_TICK (go with the
  worker trips and spawning as kernels).
Next: W4 (the structure lists as table views), then the worker trips.

## Stage D: the worker state machine as a kernel (started 2026-10-30)

User (2026-10-30): convert all of it, the order does not matter.

Measured first (ev1.json, 1M/250k, --event-metrics, steady 38-59): ~112
worker events a tick, none parked by WORKER_EVENTS_PER_TICK; JavaScript
under _unitWorkerEvent 3.9 ms a tick (~35 us an event), no hot spot: the
state machine's branches, object getters (getTileEntityRef, stat getters,
role memory), reservations, path objects. Per (type, state) a tick:
healer MOVING_TO_HEAL 22, salvager MOVING_TO 13 / RETURNING 12, builder
RETURNING_FOR_GOLD 12 / MOVING_TO_BUILD 10, healer RETURNING_FOR_GOLD 10,
collectors MOVING_TO 17 / RETURNING 7, researcher IDLE 8 /
MOVING_TO_RESEARCH 7, astar_collector MANUAL_MOVE 6, idle ones the rest.

What the machine touches (inventory):
- The worker's own state: wkS / wkT / wkR / wkN (columns already), the
  transfer cooldown, commandState, pathIndex, the path (one flow node: nvPK;
  mvOn / mvCD / mvPath released at a set), targetPos, _pendingPathTarget
  (manual moves), carryingValue and workerType (per-slot JS arrays today),
  ~45 role memory fields (UNIT_ROLE_FIELDS: object references to spawners,
  mines, queue targets; last work sites; trip costs; recheck ticks).
- Structures by tile: _ST (code, owner, uc, energy) and the class tables'
  heap columns (level, stacks, isUpgrading, isStacking, stackingWorkDone,
  markedForSalvage, queue columns, buildEnabled...), max energy from the
  static stat tables (as k_wsw_set reads them).
- Reservations (workerReservedTiles: slot = tile * types + type, with the
  per-region counts and sums for the hash, and the work grid's marks),
  the work versions (workerWorkChanged, _workerWorkHash: in mv.rs already
  for parked idle workers).
- Payments: playerResourceBatch rows (heap deltas reduced by
  resource_reduce), recordEnergyDelta (the HUD log: per tick sums are the
  same to its window rates), research points per owner and the active
  task (workRequired, workDone, cost), spawn queue payments.
- Searches: the tier (wsRegister: columns), its takes (_wsCommit /
  _wsTakeSome call the find functions), nearest spawners (worker brain
  kernel, _spawnerNearest), the healers' damaged candidates.
- Rare transitions with JavaScript consequences: construction / upgrade /
  stack done (derived stats, adjacency, text cache), salvage (destroy),
  mine emptied (ground, nav), spawner ready order, research task advance.
- Presentation: sounds (local owner), ambient sound ticks.

Design: wai.rs k_worker_ai, one serial wasm pass (main thread) over the
tick's worker events in their order (mutual effects: reservations,
structure energy, queue payments, payments), after the non-worker events.
State in heap columns; targets and spawners as tiles; payments appended to
the batch rows' heap deltas; out events (a heap list: code, slot, tile,
value) for the rare transitions and presentation, applied by JavaScript
in their order after the pass. The tier's takes call the same kernel for
their units (mode take). No JavaScript twin: each worker type's JS goes as
its kernel lands.

Stages:
D1. Worker state as columns: workerType code, carry, the role memory of
    workers as worker-record columns (spawners, pins, mines, queue commit
    as tiles; positions f32; ticks i32); the accessors decode for the
    JavaScript left (snapshots by name keep working).
D2. Kernel infrastructure: the pass, path set (flow node), reservation set
    and clear with their counts and sums, work versions, idle retarget
    schedule, tier registration, payments, out events, the arm-again step.
D3. Types in turn, JavaScript deleted as each lands: researcher, salvager,
    collectors, healer, builder, manual move; then WORKER_EVENTS_PER_TICK
    goes.

### Stage D status (2026-10-30, end of session)

Every worker type's state machine is the kernel's (wai.rs k_worker_ai):
researchers, salvagers, collectors, healers, builders; updateWorkerAI keeps
MANUAL_MOVE only. Glue: unit.js unitEventsRun lists worker events,
worker.js waiRun / waiOutEvents. Measured (prof36): the pass 1.5 ms a tick
(0.3 JS), out events 4.8 ms JS.

Left, in order:
- Out events that are state, as batch kernels (dst.rs's way): construction
  / upgrade / stack completions (markConstructionComplete and the rest: 4.8
  ms in prof36), mine depletion, queue production and ready order, salvage
  destroys into structDestroyTiles' list. Presentation (sounds, logs) stays.
- MANUAL_MOVE and pending ways (orders' resolution; pathfinding.js).
- The search tier's takes (_wsTakeSome -> the find functions with their
  results) into the kernel (a take mode), then the find functions' JS goes.
- WORKER_EVENTS_PER_TICK (only declined events count against it now).
- Check: research deposits 0 in prof36's window at 1M (HEAD 10-36).
- Tests: collector-farms (vm test of deleted JS) to rewrite as a match test.

### Serial JS left after the tile-change batch (2026-10-30, base2 profile)

Done this session: effective-level catch-up (base rows, jMaxE), tile
changes (tch.rs k_tile_changes), path regions' tile hook (k_reg_tiles).
Left, by stage (each to be converted whole, then the full test and
benchmark pass):

1. Units by slot only (the `units` array of objects goes; ~160 sites:
   snapshot / hash order, strided passes by index, the retire pass's
   swap-removes, the id map, SimUnitGone per death, spawning's object
   construction). Unblocks: deaths' bookkeeping (~3.7 ms), spawning as a
   kernel (~3.4 ms: _simUnitSlotStart, path templates, slot map pushes),
   effective levels' strided share by slot.
2. W4: structure object lists (towers / barracks / collectorSpawners) as
   table views; then structDestroyTiles' object side (structListRemove,
   structRowDetach, getTileEntityRef: ~2.5 ms) and construction
   completions (markConstructionComplete: derived stats, brain, work
   sites, upkeep, visibility, adjacency request: ~2.6 ms) as table
   operations with presentation events.
3. Pathfinding.js: A*, pending ways (_tryUpgradeAstarFallbackPath, MANUAL
   MOVE), nearest walkable, the wall push-out (_simWallPushOut via
   forEachUnitInRange), nearestTileInPathRegion.
4. Small items: healer candidates' post (_hcPost 0.5), acquisition post
   (_acqPost 0.4), nav field sweep slices (0.6), visibility cover paint
   (0.4), adjacency lane commit (0.4), status pre-pass glue (0.4),
   _simMoveChargeSteps (0.5), spawner ticks' tileEntityChangesSince.
Presentation stays JavaScript (sounds, damage looks, alerts, text caches).

### Stage U: units by slot only (design, 2026-10-30)

Measured JS it removes (base2, steps 38-59): the retire pass's reads and
swap-removes (_gameTickBody 1.2 ms, compactRemovedUnits 1.9, id map 0.3,
detach 0.3) and spawning's object work (processGlobalSpawnerQueue 3.4).
The `units` list: ~400 references in 34 files; the page (renderer, hud,
audio: ~170) and the simulation share the name and, without the worker,
the list itself.

Design:
- The simulation's unit order is the id table (main.js _uix: ids ascending,
  slots, holes -2, squeezed by k_uix_remove): the order every peer has
  without any history (a restore rebuilds it from ids), replacing the
  swap-remove order. `ix.slots` becomes _uix.slots (holes skipped by the
  kernels that read it: they already skip slot < 0).
- Deaths: one kernel over the dead column (retire kernel + k_unit_gone +
  k_uix_remove fused): the gone kernel's list, the death sound / king flags
  as columns, holes in the id table; JS only for presentation (the first
  UNIT_DEATH_SOUNDS sounds) and the objects' detach (SimUnitGone: until
  units have no objects in the simulation).
- Births: the id table appended by the spawn kernel; the object made
  lazily (owners[s] filled when JS first asks for the unit: unitAt(s)).
- `units` for the simulation's JS: an iterator over the id table
  (forEachUnit(fn), unitCount(), unitAtIndex(i)); the page keeps its own
  list (sim_frame / sim_client already hold the page's view of units).
- Snapshot / hash order: by id (was the list order): rules revision bump.
Steps: (1) the id table as the order (ix.slots from it), strided passes
by id-table row; (2) retire as a kernel, the list kept only as a page view;
(3) simulation sites to the iterator; (4) lazy objects for births.
