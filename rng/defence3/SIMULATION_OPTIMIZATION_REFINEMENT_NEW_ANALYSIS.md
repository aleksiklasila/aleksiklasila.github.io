# Refined optimization plan: workers, combat units, turrets, and the complete simulation

## Current execution plan — stable ticks below 50 ms (2026-10-02)

**This section supersedes the historical priorities, timing targets, and prerequisites below.** It is a source-based planning refinement, not an implementation or a performance result. No benchmarks or tests are to be run for this planning task. The supplied older ACTIVE measurements are context only: complete mean 152.94 ms, gameTick 131.98 ms, with movement, unit updates, spatial rebuilding, separation, stats, visibility, and worker commits dominating. Nested phase timings must not be added together.

The target is **stable 20 TPS: gameTick below 50 ms, with enough headroom that the entire authoritative tick, including mandatory work outside gameTick, also fits inside 50 ms**. Design for approximately 35 ms in gameTick and 5 ms for hashing/publication/ordinary protocol work, leaving 10 ms of headroom. These are engineering allocations, not promised measurements. Cover the supplied large-world configuration, including its actual population across all players, active workers, mass movement, combat, and thousands of towers/producers; do not assume the fixture name is the total live population.

The user explicitly deferred the known kernel/object movement divergence. Record it as an open issue and continue optimization planning; do not make repairing it stage zero again. Preserve the existing restore-slot fix and record the recent healer reduction, worker ordering, and sparse retirement changes as **working-tree implementations requiring later validation**, not completed acceptance gates. Do not change simulation code during this planning pass.

### A. Execution contract: what O(1) means here

The simulation coordinator must perform constant-time dispatch/publication and bounded work per command or committed event. It must not discover work by traversing all units, slots, towers, buildings, projectiles, particles, or map cells. Arithmetic over active populations still exists, but belongs in parallel kernels or background tiers. A helper kernel that performs a serial ordered fold is acceptable where interactions require order; it must not become an equally large coordinator callback loop.

O(1) applies to an individual lookup, validation, queue insertion, or result publication. Advancing M movers and resolving E interactions require population/event-dependent work somewhere. A main-thread Array.copyWithin over every survivor is still O(N) memory work, even when it removes a JavaScript for-loop. Likewise, copying N objects into typed inputs before dispatch, or walking N outputs afterward, does not satisfy this contract.

Use four explicit owners:

| Owner | Responsibilities | Forbidden recurring work |
|---|---|---|
| Simulation coordinator | Admit commands, advance phase/epoch, dispatch descriptors, publish completed buffers, apply rare object-only exceptions | Population discovery, searches, sorting, ordinary per-entity updates, bulk input packing/output materialization |
| Foreground simulation helpers, 20 TPS | Movement integration, immediate collision/damage/status transitions, sparse lifecycle production, dependency-required reductions | Reading buffers concurrently modified by another phase; hiding an unbounded object fallback |
| Background simulation tiers | Steering and targeting decisions, worker proposals, stats, visibility, navigation and derived indexes | Publishing according to local completion time; repeatedly overwriting live inputs |
| Page/rendering and optional render-preparation worker | Interpolation, particles, projectile arcs/trails, sound selection, culling, display-only preparation | Authoritative hit detection, damage, reservations, income, or simulation cache mutation |

First remove work; then change its algorithm; then choose cadence and worker ownership; finally consider inlining or kernel fusion. Calling a helper and immediately waiting still charges its full critical path to the tick.

### B. Current code: retain completed foundations, replace the remaining loops

| Area | Already present | Remaining implementation target |
|---|---|---|
| Tower updates | Due wheel, active status set, laser exclusions | Typed due entries, off-thread due ordering/acquisition/firing proposals, sparse destruction; no due-list object search pipeline |
| Producers and upkeep | Change-triggered production, unit/building upkeep bins | Typed transactions and invalidation; remove residual all-building guards and rare full rebuilds from the ordinary tick |
| Worker searches | Background search, K=6 replies, reservations, work grid | Typed worker execution and ordered assignment; replace `_wsTakeSome` object re-entry and proportional burst consumption |
| Healers | Posted health snapshot and per-chunk top-K; working-tree merge kernel | Bounded K=12 result validation/publication; no coordinator merging or population scan |
| Movement | Step kernel, general mover kernel, sparse post list, kernel spatial bookkeeping | Committed motion records, sparse steering/exceptions, fewer population passes, no mass Unit.update fallback |
| Spatial index | Helper key generation, sorting, fill and run metadata | Remove serial prefix/preparation tails and acquisition's ownership of live index buffers |
| Separation | Same-tick background contacts, parallel finish | Remove `_commitUnitSeparationPushes` full-slot coordinator scan; publish sparse exceptional pushes and commit ordinary pushes in helpers |
| Lifecycle | Working-tree helper retirement list and native survivor copying | Event-driven slot release and helper-owned canonical order compaction; no recurring high-water sweep or whole JS array copy |
| Projectiles | Tile-local building hits and stable spent-shot compaction | Authoritative projectile columns, parallel advance/candidate generation, ordered impact resolution, helper survivor compaction |
| Presentation | Simulation-worker events replayed by the page | Remove residual particle/audio work and all-tower laser-sound selection from gameTick, including work preceding no-op worker audio functions |
| Statuses/stats | Unit kernels, building active sets, scheduled stat updates | Compact changed-slot/event outputs instead of scanning whole output blocks; eliminate per-tick object membership checks |

Do not repeat the old J1/J2/G1 deliverables as if they were absent. In particular, projectile collision is no longer generally O(projectiles × buildings), and the spatial fill/range work already has kernels.

Use this loop-removal ledger during implementation; replacing the named loop includes its preparation and commit, not just its arithmetic:

| Current coordinator work | Replacement producer | What the coordinator receives |
|---|---|---|
| `_forEachUnitInTickOrder` block shuffle, candidate traversal, ordinary callbacks | Helper cohort/order builder and typed unit execution | Phase completion plus sparse unsupported events |
| `_commitUnitSeparationPushes` slot traversal | Separation finish/commit jobs | Exceptional terrain or accounting events only |
| `statusPrepassRun` flagged-block output traversal | Status kernel event compaction and owner reductions | Compact transitions and owner totals |
| `_wsTakeSome` materialization and profession callbacks | Worker execution/assignment jobs | Task/resource/production journals |
| Projectile prev-position/update/survivor loops | Projectile integrate/query/resolve/compact graph | Published projectile generation and impacts |
| `towersTick` due sorting, searches, destruction discovery | Typed due queue, acquisition and firing jobs | Spawned-shot and changed-structure journals |
| Floor-status safety sweep | Status mutation hooks and scheduled active entries | Due active-status output |
| Dropped-item timer loop | Expiry wheel and removal journal | Only due removals |
| `simUnitStateCollect` ordinary high-water sweep and survivor array copying | Lifecycle journal and canonical-order compaction job | Retired handles and published order generation |
| Particle loop, laser-sound tower scan, audio-reactive update | Page presentation loop and active emitter registry | No authoritative coordinator work |
| `_simEncodeWorld` object packing and visibility row copying | Column frame encoder and completed visibility generations | Buffer descriptors and dirty-region ranges |

### C. Shared interfaces and scheduling rules

Introduce these interfaces incrementally, extending the current registry and columns rather than building a second general engine:

1. **ReadView** identifies `{worldEpoch, tick, phase, generation, buffers}`. Positions, deaths, structure state and visibility have explicit phase versions. A job pins its input generation until completion. Replace mutable-array borrowing with immutable generations for multi-tick jobs; use three reusable generations initially, with capacity established outside ordinary ticks. Do not recycle a generation while a reader holds it.
2. **Job descriptor** identifies `{kernel, readView, paramsVersion, dueTick, commitPhase, chunkRange, outputGeneration}`. Parameters and bindings are per job, not merely per lane. A lane becomes a priority queue of jobs; adding projectiles/towers must not overwrite another subsystem's parameters or force it to finish early. Successor stages launch from declared dependencies without needing a tick-thread wait solely to post the next stage.
3. **Sparse output stream** contains a count, slot, slot generation/stable ID, event kind, payload, and canonical order key. Kernels write disjoint chunk ranges; helpers compact/merge those ranges. The coordinator reads a descriptor and count, not a padded result block. Separate authoritative effects from lossy presentation events.
4. **Due/dirty registry** uses stable handles, duplicate suppression, and an expiry/version token. Placement, removal, ownership, damage, status application, research, reservation and queue transitions update the relevant registry at the mutation. Full rediscovery is restricted to load/restore/bootstrap and off-thread audits.
5. **Motion record** stores destination/route generation, committed step, validity window, next decision tick, movement mode, target handle, and invalidation reasons. Integration reads this record in constant work. A blocked or stale record emits one decision request; it must not run pathfinding or a neighborhood search on the coordinator.
6. **Frame/event publication** transfers or swaps completed immutable buffers tagged with epoch/tick. Unit, structure and projectile state comes from authoritative columns/journals; avoid repacking all objects. The renderer may skip obsolete visual frames; authoritative state and protocol messages may not be dropped.

Current `simParallelRun` participates in kernels on the coordinator, and `simParallelBackgroundWait` executes unfinished chunks there. Add separate **post**, **completion check**, and **required barrier** operations. Normal background collection must not steal work onto the coordinator. Required current-tick phases may still wait for their helper dependency, and that wait counts against the 50 ms target. Keep the existing serial implementation as a compatibility mode, not as evidence that the large-world target is met without helpers.

Use deterministic job sizes, output capacities and admission quotas, never `performance.now()` cutoffs. Split expensive searches into resumable chunks so one background chunk cannot monopolize a helper through a foreground deadline. Preserve foreground priority while reserving progress for admitted background generations; a tier that receives no service is not an optimization.

Use the existing helper pool with priority queues; do not create one permanent OS thread per subsystem or TPS label. Keep rendering preprocessing separately owned and lower priority. Add one central schedule table containing each job's period, post phase, stage dependencies, commit phase, and maximum admitted work per cohort. Preserve current schedules during algorithm-only migration; phase shifts or new acquisition latency are explicit simulation revisions. Merely assigning different phase offsets cannot prevent every slow/fast-tier coincidence, so size the combined due work on each tick instead of promising that commits never coincide. Hardware-adaptive cadences and TPS negotiation are deferred until this fixed schedule is stable.

Results become visible only at their declared tick and phase. If mandatory work misses that point, finish the dependency before advancing authoritative state and record a deadline miss; do not silently retain old results on only one peer. Cosmetic work may be skipped. Any future reduction of authoritative cadence or work admission is a replicated match-setting change effective at an agreed tick, not local load shedding.

Overflow must be detected before publishing partial results. Authoritative outputs use deterministic continuation pages and backpressure; never drop hits, deaths or economic transfers. Preallocate/reuse pages and bound retained generations. Presentation events have a separate bounded queue that can coalesce or discard low-priority effects without changing gameplay.

### D. Implementation sequence and completion criteria

#### D1. Remove presentation work from gameTick

- Move particle advancement/removal, camera-relative laser sound selection, and audio-reactive updates into the page's presentation loop for both worker and non-worker simulation modes. Keep camera data entirely outside authoritative decisions.
- Publish laser activation/deactivation changes and retain an active-laser registry on the page. Select audible emitters there using its spatial/culling data, rather than scanning every tower in simulation.
- Publish projectile spawn/trajectory/correction/impact/despawn events. Render arcs, rotation, trails, and interpolation from tick-stamped state; terminate at the authoritative impact tick. Rendering never decides whether a shot hits.
- Reuse the existing simulation-event bridge. Replace nested per-effect allocations with a pooled event buffer as the producers migrate; sound recipes, buffer generation, voice selection and visual intensity remain page-owned.
- Completion: gameTick has no particle loop, camera/audio selection, or display-only interpolation work. Optional rendering preprocessing consumes immutable frames and does not compete at the priority of simulation helpers.

#### D2. Remove full scans from collection and cleanup

- Have separation FINISH emit three compact lists: already committed ordinary pushes, sparse retry/accounting events, and exceptional terrain sweeps. Apply quantization and normal position/spatial updates on helpers. Only exceptional object hooks remain on the coordinator, in canonical order; subsequently port those hooks too.
- Replace status/laser/effective-stat block flags with exact changed-slot lists and per-owner reductions. A single changed slot in an 8192-slot block must not require 8192 coordinator checks.
- Extend the retirement kernel into lifecycle events. Detach/release known removed handles directly after all readers finish. Retain one explicit full membership reconciliation at restore; remove ordinary sliced high-water retirement discovery.
- Maintain canonical unit/projectile order in typed vectors with inverse mappings and helper compaction. Keep object registries for boundary adapters; do not rebuild a JS `units` survivor array on the tick once its hot consumers have migrated. Preserve list order independently of slot allocation and compaction.
- Replace dropped-item timer decrement loops with expiry-tick entries. Cancel by generation when collected/replaced; if multiple expiries share a tick, resolve them in the existing canonical order. Snapshot remaining lifetime through the deadline representation.
- Replace floor-item status safety sweeps with complete wake hooks and bootstrap reconstruction. Keep an off-thread audit available during migration; an audit mismatch produces a repair journal, not a permanent tick-path sweep.
- Completion: an unchanged population produces no coordinator retirement/status/floor/drop scan. Coordinator collection scales with actual exceptional events, not total capacity.

#### D3. Make background jobs genuinely independent of the next tick

- Migrate acquisition away from binding live `_sx*` and hostile-table arrays. Pin an index generation plus its matching positions, owners, IDs, visibility and structure state. The next spatial rebuild writes a different generation; remove its ordinary `acqTierIndexWait` dependency.
- Build input tables from maintained columns and helper gather/copy passes. Do not populate typed buffers with a new main-thread loop over objects. Account for bytes copied; pin static layouts and copy only mutable inputs needed by each consumer.
- Preserve existing logical cadences first: acquisition and worker search every 4 ticks, healer candidates every 10 ticks, effective stats at their configured interval, and current navigation readiness. Lane names are priority classes, not evidence of those actual rates.
- Spread large result commits by deterministic stable-ID cohorts assigned at admission. A worker's cohort remains stable if other replies die or become invalid. Each lookup validates the reply and either consumes it or re-registers; it does not launch a fallback search.
- Move reductions, reply sorting, and candidate compaction into the same job graph before publication. Pointer swaps are O(1); result interpretation belongs in typed commit kernels.
- Completion: posting the next tick's index does not wait for an older acquisition reader, and no background collection runs a population job on the coordinator.

#### D4. Reduce movement, unit dispatch, spatial and separation passes

- Move look-ahead, target acquisition, crowd steering and route decisions to background preparation of motion records. Preserve the existing 16-tick far/4-tick near steering windows initially; refresh on tile entry or relevant invalidation through queued preparation. A command invalidates its old record immediately, and movement begins at the next valid foreground step.
- Foreground integration handles committed velocity, local terrain crossing, cooldown/deadline checks, and emits crossed-tile/floor/arrival events. Keep immediate local collision and damage checks in helpers. Unavailable steering retains a still-valid safe step or stops until its deterministic decision slot; it never abandons the issued order or performs a synchronous search.
- Produce helper-owned active cohorts for movers, held attackers, due attackers, workers, and exceptional states. Move shuffled block construction and canonical candidate ordering to helpers. `_forEachUnitInTickOrder` becomes a small boundary adapter for remaining unsupported cases, then leaves normal gameplay.
- Fuse STEP/MOVE only after providing their shared read dependencies explicitly. In particular, all readers must see a complete pass-start death/position snapshot before any chunk updates state. It is unsafe to run STEP then MOVE independently per chunk if MOVE reads another chunk's unfinished snapshot.
- Fuse per-slot spatial bookkeeping and sparse output emission into the phase already writing that slot where dependencies permit. Keep cross-unit reductions separate. Move radix/prefix/run construction to helpers; reuse a spatial generation across consumers with the same read phase.
- Retain 20 TPS collision for movers and combat contacts. Quiet/resting populations use the existing configurable stagger and wake on movement/contact changes. Cache summaries for unchanged spatial blocks; do not rebuild unchanged structure hostility data merely because units moved.
- Attempt pair-once separation only after the full-slot serial tail is removed. Use deterministic per-chunk directional accumulations and a fixed reduction order; preserve asymmetric radii/owner/mover rules and do not allocate unbounded contact-pair lists.
- Completion: ordinary movement does not return to Unit.update, the coordinator walks neither all slots nor all shuffled blocks, and each remaining foreground pass has a distinct required read/write boundary.

#### D5. Finish worker execution and economic commits

- Migrate profession state, target handles, cargo, transfer deadlines, task identity and reservations into columns. Keep existing search outputs and work-site indexes; replace `_wsTakeSome -> _wsTakeNow -> object AI` with typed validation/assignment/execution jobs.
- Execute resource collection, delivery, building, salvage, healing, queue payment and research as explicit transactions. Unconditional independent reductions run in parallel; contested reservation/material/queue operations fold in canonical order on helpers with a single writer for the relevant state.
- A failed candidate consumes its bounded reply list and re-registers. Maintain a due wheel for cooldown completion and task checks; changing a site's eligibility wakes registered interested workers once rather than scanning all workers.
- Publish owner resource totals, production wakeups, target changes and visual events as compact reductions/journals. The coordinator must not process one general object callback per successful worker transaction.
- Completion: fully employed workers have no per-worker object state-machine pass on gameTick, and economic throughput is preserved rather than reduced through extra waiting.

#### D6. Towers, projectiles, building statuses and lasers

- Introduce authoritative structure columns for stable identity, owner, tile, health, construction, type/stat profile, firing deadline, target preference and active statuses. Update these at mutation hooks. Extend the due wheel with typed handles and helper ordering instead of sorting JS objects in towersTick.
- Prepare tower acquisition on a 4-tick tier, aligned with the existing combat acquisition cadence; valid preferred targets retain priority. Immediate firing readiness and constant-time target validation remain 20 TPS helper work. Failed acquisition schedules another deterministic search. Record this bounded acquisition latency as a simulation revision, with interpolation of turret rotation on the page.
- Preserve tower category priority and structure tie rules. Prepare ordered candidate continuations, not just one target, where earlier actions can invalidate a choice. Shared read tables are snapshots; target liveness and contested effects are checked at commit.
- Migrate projectiles to columns and a canonical active-order vector. Parallelize prev-position capture, integration, life/range computation, local collision candidates, and survivor flags. Preserve unit-before-structure priority, aimed floor targets and hit-before-expiry behavior.
- Initially keep projectile physics at 20 TPS on helpers. Do not lower it to 5 TPS merely because the renderer can interpolate: authoritative collisions would change. A future lower-rate projectile simulation would require swept collision and explicit gameplay approval; it is outside this implementation default.
- Resolve dependent projectile impacts in reverse canonical projectile order against live typed state on a helper. Preserve same-tick tower shots, splash exclusion of the direct target, immunity and status interactions. Candidate continuation must find the next valid hit after an earlier impact kills the first candidate; no coordinator rescan.
- Preserve tower -> projectile -> unit -> producer phase ordering. Start with a single ordered helper fold for dependent effects; parallelize only partitions whose affected targets, resources and spawned effects are proven disjoint. Coordinator commits only published state and rare unmigrated hooks.
- Keep status-bearing buildings in typed active sets with deadlines; accumulate periodic visual/status reports on tiers while immediate death/eligibility transitions remain visible at their required phase. Keep production event-driven; publish population/material changes to its due queues.
- Retain existing laser row/column indexing and beam-map kernel. Replace full-slot report collection and all-laser structure updates with changed-hit streams and dirty-beam/affected-structure lists. Preserve all legal links.
- Completion: no ordinary tower act or projectile update loop on the coordinator, no full tower scan for destruction/audio, and no per-frame projectile repacking through objects.

#### D7. Remove surrounding work that would still prevent 20 TPS

- Move effective-stat profile recomputation and visibility spread/diffs through the background job graph. Apply scheduled health/eligibility mutations separately from profile cache changes. Emit only changed profiles/sources; remove residual every-unit parameter synchronization.
- Build adjacency/topology changes from dirty tiles/regions in background generations. Apply immediate local wall safety on the foreground path while larger routing tables rebuild; publish navigation generations at fixed logical readiness ticks.
- Compute upkeep from maintained histograms and profile prices. Rebuild histograms in helpers after restore; ordinary seconds commit per-owner totals, not population scans.
- Hash immutable tick generations and finalize protocol summaries on a declared later tick. Retain the corresponding snapshot/journal generation until consumers release it; do not hash mixed current/previous state.
- Publish structures/projectiles directly from columns, visibility through completed buffers or dirty regions, and map changes through journals. A render-preparation worker may perform culling, ordering and instance assembly. Limit visual frames in flight; rendering backpressure must not force simulation to repack or queue every obsolete frame.
- Completion: removing loops from gameTick does not recreate them in runOneTick, resyncAfterTick, frame encoding, or the next message handler.

### E. Critical-path allocations, overload and acceptance

| Non-overlapping responsibility | Design allocation per tick |
|---|---:|
| Commands, dispatch, sparse lifecycle/object exceptions | 3 ms |
| Foreground movement and local terrain transitions | 6 ms |
| Spatial generation and mandatory reductions | 4 ms |
| Separation including preparation and application | 5 ms |
| Unit combat, statuses and ordered hits | 5 ms |
| Worker execution and economy | 4 ms |
| Towers, projectiles and laser damage | 4 ms |
| Stats, visibility and other required maintenance | 4 ms |
| Hashing, ordinary protocol work and frame publication outside gameTick | 5 ms |
| **Complete-tick design total** | **40 ms** |

The first eight allocations give gameTick approximately 35 ms. Include waits, preparation, compaction, buffer publication and allocation pressure in their owning subsystem. Background CPU is not free: its admitted work must finish before the next generation needs its buffers, without growing a queue. A lower coordinator CPU time alone does not prove a shorter tick.

A steady stream of work must have bounded backlog age. Coalesce redundant dirty requests; keep one outstanding decision per entity and generation. Admit independent maintenance by fixed work units and deadlines, with resumable jobs. Never conceal overload by processing fewer resource transfers, losing projectiles, discarding contacts, or deferring ready damage indefinitely. Large synchronous events are represented as helper jobs with required completion, not as unlimited coordinator exception lists.

If a stage exceeds its allocation in later implementation validation, address the responsible scan, memory traffic, serial dependency, or foreground wait before expanding the next subsystem. Do not count unmeasured phase improvements or add inclusive timings. The initial complete-tick target is unchanged even if the coordinator itself becomes nearly O(1).

### F. Later verification and plan maintenance — not run in this task

Future implementation checks must cover:

- Sparse outputs versus full discovery: zero changes, one change in a large block, dense changes, slot reuse, late deaths, spawn/death at chunk boundaries, stable surviving order and selections.
- Read generations: live-index rebuild while acquisition runs, parameter/binding reuse, multi-stage same-lane jobs, buffer exhaustion, helper completion out of order, and no stale-generation writes after reset.
- Movement: long/short routes, attack-move and rally, wall detours, crowd waiting/release, held/forced/building targets, mass command replacement, and no unbounded object fallback.
- Workers: each profession completing full cycles, contested sites/resources, empty replies, cancelled work, invalid targets, and bounded decision latency without lost throughput.
- Towers/projectiles: due-edge behavior, preferred/category/tie priority, same-tick firing, reverse impact order, first-candidate death, aimed replacement floor items, splash/status interactions and hit-before-expiry.
- Presentation: camera/audio changes leave authoritative state untouched; interpolation ends on impact; slow rendering drops obsolete frames without losing simulation events or blocking the next tick.
- Whole pipeline: empty/quiet populations, the supplied ACTIVE case, moving armies, dense and dispersed combat, tower sieges, topology bursts, and sustained lifecycle churn. Include 0/1/7-helper execution for semantic coverage; the large-world timing goal applies to the supported multi-helper configuration.

The known kernel/object chase divergence is tracked separately and is not a planning blocker. New ownership/race/overflow defects introduced by a migration still need local checks; postponing divergence diagnosis does not authorize publishing partially written state. Before claiming multiplayer correctness or shipping a simulation revision, close the remaining determinism failures.

When performance validation is requested in a later task, require unchanged useful work and responsive commands, a complete-tick distribution with headroom below 50 ms, and bounded long-run queues/memory. Record p95/p99/max as well as mean; a 40 ms mean with repeated 100 ms commits does not meet stable 20 TPS. **No such runs, probes, or benchmark instrumentation are part of this plan-only update.**

Keep this section as the current implementation order. The sections below preserve historical rationale and detailed algorithm constraints; their older requirements to benchmark first or repair divergence before proceeding do not override this revision. Update `OPTIMIZATION_PROGRESS.md` only when implementation or validation actually establishes new results.
