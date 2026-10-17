# Load-first redesign for million-unit matches and adaptive simulation

## 1. Objective and execution sequence

Build toward matches containing **1M, 2M, 3M, and 4M total units**, hundreds of thousands of buildings and floor items, and maps of at least 1000×1000.

Proceed through separate qualification stages:

| Stage | What must work before advancing |
|---|---|
| A. Load | Create the complete world, display it, inspect it, and unload it reliably |
| B. Operate | Move armies, issue large orders, start production, and survive allocation growth |
| C. Sustain | Execute those workloads continuously with bounded queues and memory |
| D. Adapt | Maintain a 20 Hz control timeline by negotiating staggered simulation work |
| E. Polish | Qualify visual smoothness, response latency, fairness, and practical population limits |

A world that merely allocates successfully does not pass loading. A world that loads but freezes on its first movement command does not pass operation. A world that reports 20 control ticks while accumulating unbounded deferred work does not pass sustained simulation.

**Priorities:** responsive controls, smooth visuals, stable work slices, multiplayer determinism, approximately correct long-term gameplay, and increasing population capacity.

Remove manual TPS mode. The final engine uses automatic scheduling, with per-subsystem entity-update rates between **20 and 1 Hz**, while command transport and logical game time retain a **20 Hz base timeline**.

This is an implementation plan; the new scale limits and performance results must be measured.

### Measurement and optimization rules

- Run benchmarks serially, with recorded hardware, available memory, browser, helper counts, revision, and fixture seed.
- Record actual created and surviving counts, not requested settings or fixture filenames.
- Separate cold loading, warm loading, first action, steady activity, and recovery.
- At each blocker: capture its cause, implement the smallest architectural remedy that removes it, rerun the same case, then continue upward.
- Keep the 200k-total case as a responsiveness regression guard throughout.
- Do not postpone correctness until the end. Temporary diagnostic modes are allowed, but approximate production profiles must pass their relevant correctness gates before becoming automatic defaults.

## 2. Stage A — reliable loading before simulation optimization

### A1. Build a live-world loading and performance benchmark

Add a real-browser loading harness that uses the production match-start path and lets gameplay run normally. Measure startup time, authoritative TPS and rendered FPS together, including the transient period before performance stabilizes. Record time to the first useful frame separately from time to stable performance; use these measurements to inform when the real match should become playable. Extend existing startup and snapshot tests instead of relying on the current scale-world helper, which adds entities after a small match has already started.

Start performance testing at **2M total units and 200k total buildings/floor items on a 1000×1000 map**, with two teams. Distribute ordinary unit and placed-object types approximately equally, with one king and one of each portal endpoint per team. Exclude non-buildable passive entities and area actions from placed-object totals. Do not require smaller performance baselines before this case; small correctness tests remain useful.

Use these primary dimensions:

| Dimension | Cases |
|---|---|
| Total units | 1M, 2M, 3M, 4M |
| Buildings plus floor items | 100k, 200k, 400k |
| Map dimensions | 1000², 1500², 2000² |
| Players | Two owners initially; then three-player asymmetric tests |
| Unit composition | Homogeneous combat units; mixed combat/worker population |
| Static composition | Building-heavy; floor-heavy; mixed |

Run the initial 2M/200k/1000 case first. Then extend to the 36 count/map combinations with the mixed fixture. Use homogeneous and category-heavy variants to diagnose failures and qualify boundary cases. Retain 200k, 400k, and 800k cases for later regression and scaling comparisons, not as prerequisites for the initial run.

For each load, report:

- Runtime/module startup.
- Terrain generation or receipt.
- Placement planning.
- Allocation and initialization.
- Entity creation and reference linking.
- Spatial, navigation, visibility, and adjacency initialization.
- Initial state validation.
- First useful frame and presentation completion.
- Multiplayer transfer and readiness.
- Peak and retained memory by process and subsystem.
- Authoritative TPS and rendered FPS during startup, stabilization, and a separate steady measurement window; include frame-time tails and actual surviving populations.

Memory measurements are supporting diagnostics, not admission criteria. Judge success by actual loading, responsiveness, stability, and in-game performance. Paging is allowed. Do not skip, cancel, or fail a case because of free RAM, an estimated footprint, or a reserved-memory threshold. If a real allocation failure, crash, or performance problem appears, capture evidence, measure the relevant memory costs, compact or redesign storage as needed, and rerun the same case.

Measure responsiveness during loading: overlay updates, camera/preview interaction where available, cancel latency, and longest page task.

Verify exact populations, unique IDs, owner counts, valid references, legal placement, initial hashes, and the ability to select representative entities. Impossible building placement is reported explicitly; silently creating fewer objects is a failed fixture.

**Gate:** each feasible case loads three consecutive times, displays a useful running world, reports startup/stabilization time and concurrent TPS/FPS, and cancels/unloads cleanly. Record failure to stabilize explicitly. An observed allocation failure is recorded separately from a software failure and becomes the next memory-reduction target; low free RAM alone is neither kind of failure.

### A2. Replace page-owned world creation

The current startup path creates the host world on the page, builds a full JSON snapshot, parses it on the page and worker, and initializes a replacement world before applying the snapshot. Replace that ownership model.

Implement a cancellable loader state machine:

`prepare → terrain → placement → allocate → populate → link → indexes → validate → present → ready`

- The simulation worker owns authoritative world creation from the beginning.
- The page receives progress, summaries, shared render bindings, and small selected-object details.
- Split UI setup from world initialization. Snapshot restore must not generate a disposable map first.
- Solo starts directly in the worker without a snapshot round trip.
- Multiplayer hosts generate canonical terrain and startup data in the worker.
- Helpers receive references to existing shared storage; they do not construct duplicate worlds.
- Separate `worldReady`, `presentationReady`, and `matchReady`. Start gameplay only when the required world and minimal presentation are usable.

Process loading in bounded batches. Yield between batches to service cancellation and progress. Wall-clock-based yielding is permitted during loading because it changes execution pacing, not creation order or results.

Use one load-generation token across worker messages, helper jobs, network transfers, and presentation. Results from cancelled or superseded loads are discarded.

**Failure behavior:** worker startup or allocation failure returns an actionable error. Do not fall back to constructing a multi-million-unit simulation on the page.

### A3. Bulk-create entities and batch initialization side effects

Introduce a bulk world builder with predictable allocation and deterministic creation order.

- Count required units by owner, type, and level before allocating.
- Initialize common fields through typed-array ranges and WASM batch kernels.
- Share immutable stat rows and type metadata.
- Allocate worker, explicit-path, status, and unusual-combat state only for entities that need it.
- Replace mandatory heavyweight unit objects with slot/generation handles and lightweight accessors. Create page-side inspection wrappers only on demand.
- Build buildings and floor items through bulk paths as well; their counts are large enough to matter independently.

Provide a scoped bulk-construction transaction that defers expensive derived work:

- Adjacency and navigation invalidation.
- Visibility registration.
- Population and upkeep recounts.
- Structure indexes.
- Presentation metadata.
- UI text and range caches.

At transaction completion, perform each required rebuild once, in deterministic order. Essential primary state and ownership accounting must still be initialized correctly.

First compare the bulk constructor with ordinary construction on small fixtures. Then use bulk construction in the real loader; do not leave a benchmark-only shortcut.

### A4. Fix placement and map-memory scaling

Replace repeated starter-unit BFS expansion with one resumable traversal per spawn region.

- Use typed queues, integer tile IDs, and visitation stamps.
- Preserve deterministic traversal and tie-breaking.
- Stop once enough legal placement slots are found.
- Reuse the traversal when extending the region instead of restarting from the origin.
- Allocate deterministic sub-tile offsets appropriate to the requested density.
- Report insufficient legal space rather than cycling indefinitely or silently truncating armies.

Retain the existing resumable building-placement cursor, but profile its placement hooks and batch their derived work.

Move large map state toward flat typed storage:

- Terrain/type, owner, area ID, and entity handles.
- Compact visited bitsets and typed flood-fill queues.
- Sparse or pooled worker reservations instead of dense arrays of object references for every tile and worker category.
- Lightweight cell accessors where migration requires compatibility.

Remove duplicate map and area representations when they can be derived or shared. A larger map must not multiply equivalent object graphs across the page, simulation, and presentation workers.

### A5. Make memory capacity explicit

The current WASM heap is configured for **65,536 pages of 64 KiB: a 4 GiB ceiling**. Increasing ordinary JavaScript heap settings cannot remove that limit.

Add an allocation ledger that distinguishes:

- Logical live bytes.
- Allocated capacity.
- WASM committed size and allocator fragmentation.
- Shared buffers, counted once rather than once per view.
- JavaScript objects and external backing stores.
- Presentation/GPU allocations.
- Loading, transfer, growth, and recovery temporaries.

Measure startup and first-action memory costs after the fact, as diagnostics: include movement, targeting, pathfinding, separation, and rendering scratch—not just dormant unit columns. Never estimate requirements up front to refuse, shrink, or delay a load; paging is the operating system's job.

Implement these remedies in order:

1. Remove duplicate worlds, JSON strings, object graphs, and snapshots.
2. Separate hot columns from cold metadata and optional sidecars.
3. Replace population-wide capacity growth with fixed-size storage pages and stable handles.
4. Allocate scratch by active work and reuse it across compatible phases.
5. Move non-kernel cold state and presentation storage outside the WASM heap.
6. If the measured hot working set still exceeds the safe single-heap budget, introduce multiple bounded WASM storage banks.

Use 65,536-slot storage pages, addressed by a global slot’s page and offset. Page allocation must not imply a 65,536-entity execution job; work chunks remain much smaller.

For multi-bank storage:

- Instantiate kernels against individual memories.
- Keep IDs, global slots, and generations independent of physical placement.
- Pass compact cross-bank query records and deterministic interaction intents.
- Merge cross-bank effects in canonical order.
- Do not attempt to make a kernel dereference a pointer belonging to another memory.

Audit signed pointer coercions and arithmetic above 2 GiB, length overflow, sentinels, GPU indexing, and map-index products. Keep global entity and tile identifiers at least 32 bits.

When observed loading or runtime problems justify memory optimization, use startup peak memory of **no more than 1.35× retained memory plus 256 MiB** as an engineering target, with bounded transport buffers. This is not a load-admission or performance-qualification gate; actual loading and in-game behavior determine the outcome.

The benchmark runner does not reserve system headroom or stop a case based on free memory or paging. Attempt the requested workload and judge its actual load outcome and in-game performance. Keep observed allocation failures, crashes, stalls, and poor TPS/FPS visible in the results. Use memory measurements to diagnose those observed problems and guide compaction or architectural changes, then repeat the same workload.

### A6. Replace whole-world JSON transport

Use two complementary formats:

**New-match startup**

Send a versioned manifest containing canonical terrain/areas, configuration, player state, placement data, and compact spawn runs. All peers use the same deterministic bulk constructor. The host’s map remains authoritative; guests do not independently regenerate potentially different terrain.

**Save, restore, join, and resync**

Use versioned binary sections for canonical state, references, and scheduler state. Decode directly into destination storage.

For both:

- Include counts, lengths, schema/rules versions, generation, and checksums.
- Use approximately 1 MiB codec chunks, fragmented into transport messages compatible with the existing channel.
- Bound the in-flight window to 8 MiB per recipient initially.
- Apply transport backpressure; do not enqueue an entire multi-gigabyte state.
- Compress chunks independently when beneficial and supported.
- Resolve cross-references in a separate pass after entity allocation.
- Reject missing, corrupt, duplicated-conflicting, or wrong-generation chunks.
- Release each chunk after application; never assemble a giant string or require the entire compressed payload in memory.

The host no longer needs to serialize and restore its own initial world to normalize it. Canonical bulk initialization and initial logical-state hashes establish agreement.

Initial readiness requires matching canonical state hashes. Derived caches may be rebuilt locally only where their timing and representation cannot affect gameplay.

### A7. Loading progress, recovery, and repeated matches

Replace size-derived silent timeouts with progress-aware monitoring.

- Publish completed batches and bytes at least every 250 ms when work is advancing.
- Track transfer progress separately from construction and indexing.
- Treat heartbeat-only activity without completed work as stalled progress.
- A long load with real progress remains alive; a dead worker is recoverable.
- Keep cancellation responsive between bounded tasks.
- Free channels, buffers, presentation state, and outstanding jobs on failure.

Repeat load → inspect → unload five times near the supported maximum. Require retained memory to plateau. Because WASM memory cannot shrink, recreate match-owned workers/memories between matches when needed.

Before leaving Stage A, test initial multiplayer load, cancelled guest load, disconnected loader, a retry, and a paused-world save/restore at the largest supported case.

## 3. Stages B and C — make large worlds operational, then sustainable

### B1. Introduce a diagnostic execution mode

Provide developer-only controls to:

- Remain paused after loading.
- Execute one complete authoritative tick.
- Execute a fixed number of ticks.
- Pace legacy ticks slowly while keeping the UI responsive.
- Force a selected stagger profile once available.

A legacy tick executed once per second is only a diagnostic tool; it is not the final time-correct 1 effective TPS mode.

Begin with single-step execution. Record all first-use allocations and lazy initialization. Prewarm only capabilities actually present in the fixture; avoid allocating every possible subsystem merely to hide first-tick costs.

### B2. Qualify actions in increasing scope

For every load-qualified population, run the following sequence:

| Test | Escalation |
|---|---|
| Selection | Individual → box → 10% → entire army |
| Movement | 1% → 10% → 50% → all movable units |
| Destinations | One shared destination → 10 → 100 |
| Order replacement | Move → stop → move; repeated attack-move |
| Production | 1% → 10% → all production buildings |
| Growth | Spawn an additional 5%, then cross a storage-page boundary |
| Workers | Mass assignment, arrival, gathering, delivery, construction |
| Topology | Placement/removal near moving armies; narrow passages |
| Retirement | Mass deaths, salvage, slot reuse |
| Recovery | Snapshot/restore with active movement and queues |

Use real input paths for representative cases. Direct worker commands remain useful for isolating simulation costs but cannot qualify UI responsiveness.

Record first response, completion distribution, queue depth, memory peak, and the exact number of affected entities.

### B3. Remove action-size cliffs

Large orders must not create several million-element JavaScript arrays or repeated serialized ID lists.

- Encode exact membership as sorted ranges, bitmaps, or chunked ID lists, selecting the smallest representation.
- Preserve stable IDs and generation validation.
- Register reusable command-group handles for repeated orders.
- Freeze group membership at a defined authoritative admission tick.
- Keep membership transfer and command execution separate, bounded, and cancellable where appropriate.
- Deduplicate retransmitted orders and apply each command once.

Process assignment in fair deterministic batches. Units continue their old valid behavior until their new order is installed; later orders supersede earlier queued assignments predictably.

Share navigation fields per destination/profile/topology generation. Never create one complete path or search per unit for an army-wide move.

Represent large production requests as counted queue entries, not one object per future unit. Generate individual entities only when production completes. Batch identical economic calculations while preserving ownership, spending, and completion order.

### C1. Establish sustainable fixed profiles

After actions work, run sustained activity before enabling automatic adaptation.

Implement elapsed-time integration and cohort scheduling behind forced profiles. Test strides of **1, 2, 3, 4, 5, 8, 10, and 20 base ticks** independently.

At each profile, measure:

- Entire scheduler slice and critical-path phases.
- Units visited and bytes touched per subsystem.
- Helper utilization and waits.
- Queue age and maximum deferred-work age.
- Actual game-time advancement.
- Renderer preparation, upload, and frame times.
- Memory growth and garbage collection.

A slower profile must reduce recurring work, not merely spread equivalent work into a backlog.

### C2. Apply bottleneck-specific remedies

| Measured blocker | Concrete implementation response |
|---|---|
| Full-population movement pass | Due-block traversal plus timestamped motion anchors |
| Spatial rebuilds | Incremental membership and conservative motion envelopes |
| Pairwise separation | Density-field pressure with bounded local refinement |
| Repeated targeting | Scheduled acquisition, shared cell candidates, cached valid targets |
| Worker event storms | Due queues, shared searches, reservations, aggregated homogeneous work |
| Building scans | Event/deadline scheduling and dirty-region updates |
| Repeated stats | Shared stat rows, versioning, lazy refresh with bounded age |
| Large clears/copies | Generation stamps, changed-block lists, sparse sidecars |
| Allocation spikes | Storage pages, scratch reuse, advance allocation |
| Presentation scans/uploads | Independent cadence, changed blocks, culling and persistent GPU state |
| Command serialization | Compact membership and reusable group handles |
| Hashing/recovery | Incremental logical digests and streamed canonical sections |

Optimize the dominant measured cost first. Do not add a global abstraction or more helper threads without confirming that it improves the critical path.

**Gate:** workload remains operational for ten minutes with bounded queues and memory, even if the initially qualified profile is only 1 effective update per entity per second.

## 4. Stage D — deterministic adaptive scheduling and gameplay integration

### D1. Introduce explicit time and schedule interfaces

Implement:

- `baseTick`: 50 ms authoritative game-time boundary.
- `ScheduleProfile`: subsystem strides, quotas, approximation settings, rules version.
- `scheduleEpoch`: committed profile generation.
- `lastIntegratedTick` and `deltaTicks`: elapsed-time accounting.
- `MotionSegment`: timestamped motion, route reference, identity and topology generation.
- `positionAt(entity, tick)`: common-time query.
- `LoadManifest` and streamed snapshot sections carrying the same scheduling state.

Keep seconds-to-game-time conversion fixed at 20 base ticks per second. Effective update frequency never changes movement or production units.

Audit all decrementing timers, modulo sweeps, phase seeds, cooldowns, budget refills, expiry queues, statistics sampling, and helper reuse assumptions.

### D2. Stagger population work while retaining a 20 Hz timeline

Use stable, locality-preserving cohorts distributed across owners.

- Maintain due-block queues; do not scan all entities to find due ones.
- Separate movement, separation, perception, worker decisions, and maintenance schedules.
- Keep dependent spatial phases on compatible generations.
- Preserve elapsed credit across schedule transitions.
- Reserve deterministic urgent capacity for commands and invalidated behavior.
- Rotate budget service fairly among players and commands.
- Never derive authoritative priority from camera position, local selection, FPS, or helper completion order.

Local timing influences only proposed future profiles. Every peer executes the same committed quotas and schedule.

### D3. Movement, collision, and spatial consistency

Evaluate an entity’s motion at the current logical time, then update its steering or route only when due.

- Multiply steady motion by elapsed time.
- Carry fractional distance through quantization.
- Traverse route segments and crossed terrain features without replaying all-world ticks.
- Use swept wall/clearance tests and local subdivision at turns or hazards.
- Invalidate affected motion on topology changes.
- Query other entities at the same logical time.
- Index conservative trajectory envelopes so stale spatial membership cannot miss a moving candidate.

Do not accumulate blocked travel into a later jump. Approximate crowd overlap is allowed; terrain tunneling is not.

### D4. Density-based separation

Replace high-density neighbor-pair work with fixed-size field sampling:

- Maintain fixed-point density and directional-flow aggregates.
- Update contributions incrementally from due cohorts.
- Process dirty field tiles on helpers with fixed halos.
- Sample a bounded stencil per updated unit.
- Distinguish friendly and hostile pressure.
- Add deterministic balanced symmetry breaking for perfectly overlapping units.
- Apply bounded acceleration and smooth pressure relaxation, not multiplied stale pushes.
- Restrict exact contact refinement to bounded exceptional work.

This makes separation approximately O(1) **per updated unit**, plus field maintenance—not O(1) for the whole population.

Start with a 90% soft-radius floor for reduced-quality profiles; qualify 80% separately for emergency profiles. Blend changes over logical time. Terrain clearance, hitboxes, and attack ranges do not shrink with the soft crowd radius.

Keep existing separation where it remains inexpensive and smoother. Profile changes are shared across peers.

### D5. Preserve average gameplay rates

Separate decision frequency from accumulated activity.

- Acquisition may be less frequent; existing attacks retain cooldown phase and firing credit.
- Damage, healing, gathering, research, production, and upkeep integrate elapsed time.
- Preserve fractional remainders and conserved resources.
- Batch equivalent repeated work only while eligibility remains unchanged.
- Split at death, depletion, expiry, completion, range exit, or other relevant boundaries.
- Use swept projectile collisions and deterministic impact ordering.
- Keep authoritative impacts independent of cosmetic projectile cadence.

Prevent permanent cohort advantages through rotating service and deterministic simultaneous-effect resolution where applicable.

Replace periodic modulo checks with deadlines/cursors that cannot miss an interval after schedule changes. Deferred work must have an explicit bounded-age policy.

### D6. Negotiate profiles across players

Report worker telemetry every 500 ms using a rolling two-second window.

Default controller:

- Target p95 slice time ≤42 ms and p99 ≤45 ms.
- Reduce work after two reports with p95 >45 ms.
- Request urgent reduction after two consecutive slices >60 ms.
- Restore one level only after ten stable seconds and a predicted candidate cost below 40 ms.
- Reduce the dominant measured subsystem first.
- Include every authoritative simulation participant, including the host.
- Exclude network waiting and intentional pauses from compute estimates.

Use proposal → worker-ready acknowledgement → canonical committed activation.

Activation must be beyond sealed work and allow at least 500 ms plus measured transport requirements. Peers cannot cross activation without the agreed profile. Worker-owned automatic sealing must honor the same barrier.

Carry committed schedules, pending transitions, cohort cursors, credits, and required pipeline state through snapshots, reconnect, and host migration.

Remove the old behavior that stretches game-time delivery to accommodate slow computation. At the 1 Hz entity-update floor, unresolved overload is reported and handled through explicit stall/recovery rather than hidden slowdown.

## 5. Stage E — presentation, acceptance, and final qualification

### Continuous visuals and responsive controls

Render timestamped motion at display cadence.

- Follow validated route segments rather than interpolating through walls.
- Use bounded prediction and correction blending in route space.
- Preserve visual identity; never swap units to conceal corrections.
- Stop prediction at unknown or expired route horizons.
- Separate teleport/resync resets from ordinary motion corrections.
- Make animation, turning, effects, and smoothing depend on elapsed time.
- Preserve visibility restrictions when predicting or displaying history.

Publish changed motion blocks and compact metadata. Presentation owns its history and never blocks simulation.

Provide immediate selection, order markers, placement ghosts, and queue feedback. Distinguish pending feedback from authoritative movement, spending, damage, and spawning.

Measure input-to-feedback, acceptance, authoritative application, first motion, and group-wide response separately. Target 300–500 ms first visible movement at 4 effective TPS in low-latency benchmark conditions; report longer delays honestly at 1 TPS.

### Compatibility and recovery

- Remove manual TPS controls and ignore their legacy settings during import.
- Version simulation rules, binary state, startup manifests, and presentation ABI.
- Reject incompatible multiplayer participants before expensive loading.
- Convert legacy saves at a load boundary; historical replay identity is not promised.
- Stream recovery into replacement storage without retaining two full worlds when memory cannot support it.
- For memory-constrained full recovery, pause at a canonical boundary, release replaceable state, rebuild, validate, and resume. Never continue displaying mutable partial state as authoritative.

### Required correctness tests

Require identical canonical hashes for the same schedule and commands across helper counts, supported browsers, and heterogeneous peers.

Exercise:

- All fixed profiles and repeated profile transitions.
- Long elapsed intervals, fractional rates, and deadline crossings.
- Walls, corners, fast projectiles, traps, portals, and topology changes.
- Dense overlap, symmetry, opposing armies, and narrow passages.
- Command replacement, starvation, mass queues, deaths, and allocation growth.
- Snapshot corruption, interruption, duplicate chunks, cancellation, and resumption.
- Worker loss, page stalls, automatic sealing, reconnect, and host migration.
- Large-map and above-2-GiB pointer/index boundaries.
- Rematch and repeated loading without retained-memory growth.

Compare approximate profiles with the 20 Hz reference over equal simulated durations:

- ≤1% long-run unobstructed movement-rate error.
- Exact resource conservation; ≤1% rate error where quantities are continuous.
- No forbidden terrain crossings.
- No persistent owner/cohort advantage in mirrored battles.
- At least 100 paired seeds for fairness qualification near approximation thresholds.

### Performance and playability qualification

For each claimed supported population:

- Three measured runs, at least 15 seconds warm-up and 60 seconds active measurement.
- Ten-minute soaks at schedule thresholds and the largest playable case.
- Rendering disabled, 2D, and 3D.
- Close crowds, whole-map views, empty views, and continuous camera motion.
- Full visibility, team visibility, and history.
- Real selection, large commands, building queues, and topology edits.

Begin with singleplayer; repeat qualifying cases with two and three peers. Use separate machines for heterogeneous-hardware conclusions. Same-machine peers remain a contention stress test.

Acceptance:

- Complete loading and first-action success.
- Stable 20 Hz control progression without accumulating time debt.
- Sustained scheduler p95 ≤42 ms and p99 ≤45 ms.
- Bounded authoritative queue age, prediction age, memory, and transfer buffers.
- Zero unexplained peer divergence.
- Local visual input acknowledgement p95 ≤50 ms.
- Target 60 FPS in qualifying views, with p95/p99 and long-frame counts reported.
- No unexplained >5% regression at 200k units or more than one additional base tick of command latency.
- Crowd motion assessed through stalls, jumps, reversals, overlap, and correction distance—not FPS alone.

Continue upward beyond 4M where capacity permits, then refine the practical boundary with smaller population increments.

Deliver a results table that separately identifies:

1. Maximum reliably loadable world.
2. Maximum operational world.
3. Maximum sustained real-time world.
4. Maximum visually comfortable and responsive world.
5. The limiting subsystem and next concrete remedy at each boundary.

The work is complete when the architecture, tests, and measured limits support those distinctions—not merely when the largest fixture reaches the loading screen.
