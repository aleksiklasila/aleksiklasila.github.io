# Refined optimization plan: workers, combat units, turrets, and the complete simulation

## 1. Objective and newly established opportunities

The goal remains **at least 20× faster complete ticks**, including a realistic economy where all workers can work simultaneously. Idle workers are a smaller workload of the same architecture; no pause-mode feature or assumed idle percentage is needed.

Planning refinement based on source inspection on 2026-10-01. No simulation code was changed and no benchmarks were executed for this refinement. Baseline timings below are inherited from the supplied plan, not remeasured. This document extends that plan; existing implementation and benchmark documents remain historical context.

### Acceptance targets

For the supplied workload and hardware configuration:

| Scope | Baseline | Target |
|---|---:|---:|
| Complete tick p50 | 866.95 ms | ≤43.35 ms |
| Complete tick mean | 961.65 ms | ≤48.08 ms |
| Logical unit-update work, including replacement preparation and commit | 433.83 ms in the later measurement window | ≤21.69 ms |
| Hashing and ordinary resync bookkeeping | 41.67 ms in that window | ≤2.08 ms |

Require a separate ≥20× whole-tick improvement on sustained active-worker workloads. Their baseline remains to be measured during implementation.

Keep phase timings comparable: moving work out of `_forEachUnitInTickOrder` or `resyncAfterTick` does not remove that work from its logical measurement scope.

### New findings that extend the previous plan

| Finding from current code | Added optimization |
|---|---|
| Large effective-stat batches bypass the summed-area-table path and directly scan every query rectangle in helpers | Deduplicate queries and retain algorithmic acceleration at large populations |
| An “unchanged stats” refresh still floors/clamps health and changes bookkeeping | Separate profile recomputation from scheduled gameplay mutations |
| Navigation rebuilds compute a destination search for every cluster | Demand-driven destination data, local rebuilds, and incremental repair of retained destination trees |
| Research-target eligibility can advance research | Extract side effects before parallelizing target search |
| Healer candidate selection scans all units every ten ticks | Parallel local top-k reduction over typed health data |
| Separation examines contacting pairs from both sides | Pair-once geometry with independent directional corrections |
| Frame publication scans every unit through objects and compares every map cell | Direct column publication and persistent change journals |
| Partial snapshots still scan broad entity collections; navigation globals can scan the map | Region-indexed extraction and explicit navigation snapshot state |
| Hostile summaries repeat “sum all other players” inside player loops | Shared totals and per-owner subtraction |
| Structural and world-maintenance changes have several independent invalidation paths | One typed change journal with explicit consumer boundaries |

These are opportunities established by code inspection. Their individual timing contributions are not yet measured.

### Second refinement: corrections and sharper implementation choices

- Reservations already persist through set/clear mutations. The expensive recurring reconstruction is the lazily rebuilt worker target-conflict index, not a per-tick reconstruction of the reservation array.
- Worker candidate choice is an ordered fold with a near-tie condition and lexical string keys. An ordinary numeric sort or parallel minimum reduction is not an equivalent replacement.
- The shared spatial build already parallelizes key generation and sorting, but still fills object lists and range/owner metadata in serial population loops.
- Helper jobs use claimed chunks and an aggregate completion count. The current error handler does not recover an already claimed chunk, and owned-state kernels cannot simply be rerun after partial writes.
- Navigation rebuild publication already follows deterministic multi-tick stages. Incremental computation must not make paths available earlier merely because it finishes sooner.

The plan below incorporates these corrections. Favor bounded changes with measured end-to-end benefit before introducing the most complex algorithms.

### Third refinement: measured state and revised priorities (2026-10-01)

Implementation has started; `OPTIMIZATION_PROGRESS.md` is the working log (what changed, how to verify, every measurement, next steps). Read it first in a new session. Summary as of the end of 2026-10-01:

**Measured** (`tests/100000-1000.json`, ~200k units, HELPERS=7, `.claude/tickbench.cjs` / `.claude/benchall.sh`):

| Workload | Start of work | Now (p50) | Gap to ≤50 ms |
|---|---:|---:|---:|
| base (supplied mix, mostly idle) | ~867 ms (inherited) | 266–275 ms | ~5.4× |
| ACTIVE (workers employed) | not measured before | 493 ms (second round) | ~10× |
| BATTLE=mix (armies fighting) | 497 ms (first measured) | 445 ms (second round) | ~9× |
| siege (TOWERS=8000 per team + BATTLE=mix) | 664 ms (first measured) | 628 ms | ~12.5× |

Where base time goes now (ms/tick): separation 53–56 (kernel ~21, the rest preparation and apply), movement kernel run 36–38 (serial slot bookkeeping ~13), unit pass 29, hashing/resync 26, thing stats 15, coverage hold end 15, visibility sync 11, unit index 11, barracks 9–11, unit effective stats 8, building statuses 5–14.

Where siege time goes (ms/tick): unit pass 284 (attack-move 84, units attacking buildings 81, chase 62, idle combat 50, firing 46, idle workers ~150 in total), movement 51, resync 45, towers 37, separation 27, thing stats 24, status prepass 13, queued orders 12, projectile setup 11, building update order 11 (was 58).

**Done or started, by workstream**: determinism repair (prerequisite, complete); A6 idle workers parked in the movement kernel with exact version checks (work hash replicated in the kernel, builder watchdog wakes); E4/E5 partial (scan-before-move, kernel chase for chasers without a path, hold); C partial (unit effective stats computed in kernels from typed level/stack columns; thing stats still open); G1 done (unit index fill/ranges/owner counts in kernels, slot-based entries); H1 partial (hash 44.8 → ~25 ms); F partial (exact tile bounding-box culling; pair-once not started); K1 partial (laser links indexed and deferred); visibility coverage-hold kernel; building update order cached by list reference.

**Revised priorities** (largest measured remaining cost first):

1. Structure-heavy combat. Realistic games have **5–10k towers** (like barracks), so towers engaging towers, units sieging tower lines, and towers firing on units are a main workload, not an edge case. Units targeting buildings have no kernel mode yet (E4 extension); attack-move units rescan structures because hostile structures are always in reach; turrets need due-action scheduling (J1); projectiles need the structure broad phase (J2) and a cached rank map; building statuses run on every building every tick (L2 active set).
2. Chase with paths (~70% of chasers) and firing ticks in kernels (E5, E7). Queueing mine damage like hits removes mid-pass deaths, which are the reason for turn re-checks.
3. Separation pair-once and smaller reach (F); movement slot bookkeeping in a kernel; coverage ring updates in parallel (order-free final state).
4. Hashing remainder (H1/H2): building statics and list order.
5. Active workers (A1–A5): MOVING_TO and search costs dominate ACTIVE.
6. Traps (lava, water, ice, poison, sand, mines; a few thousand, with units crossing them): measure once. Their reach is one tile, so they should be cheap to batch; low priority.

**Fourth round (2026-10-01)**: siege diagnosis found idle-worker wake-ups dominated by bounty drops (hundreds per tick, each waking every worker type of every player nearby) and attack-move hand-backs on structure ticks with no structure actually in range. Drops are replaced by **shrines** (user design: damage taken accumulates as a per-player 💀 resource, drained passively into ⚡/★ by researched multiplier and drain rate; menu option, off restores drops), and the movement kernel checks hostile structure tiles exactly before handing back. Remaining siege priorities unchanged: units attacking buildings (kernel hold for building targets), chase with paths, firing ticks, towers (J1), collector conflict index (A4).

### Fourth refinement: the layered tick (2026-10-01, user direction)

Goal first: a stable 20 TPS (every tick < 50 ms) with 200k units and 10k+ buildings; deterministic approximations are accepted (fair to all players, never game-breaking: units must not get stuck for good, orders must stay responsive), and exactness is tightened afterwards. Parallel kernels alone cannot close the remaining ~10x: the tick still sweeps every unit and building many times, and object code runs for tens of thousands of units a tick. The tick is reorganised into layers:

| Layer | Runs | Contents | Rule |
|---|---|---|---|
| L0 tick path | every tick, simulation thread + foreground kernels | commands -> intents; movement integration (position += movement + separation vectors); attack/damage/death/spawn commits; economic commits; committing the background results; starting the hash | O(1) per active entity, no searches or loops over other entities or tiles |
| L1 same-tick background | helpers, started from a frozen copy at the tick's start, committed at the tick's end | separation/shove vectors, visibility coverage, crowd/flow heatmaps, effective stats, combat-scan answers, column hashing | inputs = the tick-start state (x0/y0, columns); nothing in flight between ticks, so snapshots and restores need nothing new |
| L2 staggered | each entity every K ticks by (tick + id) % K, its share of a tick | unit and worker decisions (searches, target validation, state changes), building updates (statuses with K-tick steps, production, stat refresh), healer candidates | per tick O(entities / K); urgent cases (a player order to the unit, an attack that is due) run at once |
| L3 slow background | multi-tick jobs on the helpers, installed at a fixed tick | navigation builds (done), work/opportunity index, region summaries | inputs are copies made at the start; results installed at start + D on every peer; a restore rebuilds from snapshotted inputs |

Determinism rules for asynchronous work: a job reads only frozen inputs (copies, or columns nothing writes until its commit); its result is committed at a fixed tick and point in the tick, never "when ready" (the simulation thread waits, or runs what is left itself); kernels are pure; same-tick jobs are preferred because a restore happens between ticks. Peer-local timing (helper count, machine speed) never changes results.

Approximations adopted (each with its fallback):
- Separation (L1): pushes computed from tick-start positions and applied after the unit pass (one tick of latency); a unit blocked in a crowd for a while moves without pushing (as flyers do) along its flow, reconsidered on staggered ticks. Crowds: units held back beside idle or waiting units of their own wait (still), look again every 16 ticks and try every 64 (implemented; also to be used away from destinations).
- Visibility (L1/L2): coverage from tick-start positions, area changes applied with up to a few ticks of latency; sight may last a few ticks longer.
- Building statuses and timers (L2): processed every K ticks with K ticks' worth of decrement/damage.
- Unit decisions (L2): every K ticks per unit (movement every tick); latency hidden by animations later (reloading, reading a map).
- Worker work (L3): found through a work index rebuilt every few ticks (nearest region with work, O(1) lookup, reservation, fallback: wait for the next build).

Measured costs to remove (ms per tick, HELPERS=7; base = 157k units marching across the map, siege = 16.4k towers + armies):

| Item | base | siege | Plan |
|---|---:|---:|---|
| Separation | 53 | 27 | L1 job overlapped with the unit pass; movers every tick, resting units every K; stuck units ghost |
| Movement kernel run + mover bookkeeping (tile/zone/visibility per mover) | 59 | 51 | bookkeeping into kernels, visibility deferred to L1 |
| Unit pass (walk + Unit.update) | 32 | 158 | activity list (no walk over 200k), L2 decisions every K ticks |
| Visibility (sync, update, hold end) | 35 | 38 | L1 job from tick-start positions |
| Hashing / resync | 26 | 45 | column hashing as an L1 job; fewer object fields per tick |
| Building statuses, stat refresh, barracks, spawners | 48 | 70 | L2 every K ticks, quiet buildings skipped |
| Towers, projectiles | 4 | 46 | due-shot scheduling (J1), L2 targeting |
| Index rebuild, effective stats, other | 30 | 40 | kernels (done) and L1 |

Order of work: separation as an L1 job; the unit pass activity list and L2 decisions; building L2; visibility L1; hashing; towers; the work index (L3). Each step is measured on base and siege and checked with the determinism suite (run on a snapshot copy of the tree so work can go on meanwhile).

**Contract additions learned during implementation** (details in the progress log, "Determinism rules learned"): a restore disarms kernels on the restoring peer only, so every kernel decision must equal `Unit.update` exactly; reads of other units during the unit pass use pass-start state (positions, frozen spatial counts, A* budget at pass start); large-world paths are gated by unit-count thresholds, so tests must force them on (`CHAOS_SIM_EVAL`, `HOST_SIM_EVAL`); freed unit slots are reused only from the next index rebuild; caches validated by object references or immutable keys are dropped on snapshot decode; `SNAP_HASH_SLICES` stays 10.

### Fifth refinement: one tick path, brains in the background (2026-10-01, user direction)

The user's direction, sharpened: the tick path is **one** path, not "kernel plus object fallback". Each tick every unit (and turret) only does what a player perceives at once: it moves (or stands) along its current movement order, turns, and the tick commits what the background layers decided (damage, transfers of goods, new orders). Nothing on the tick path costs more than O(1) per entity: no searches, no pathfinding of any kind (A* or flow builds), no rerouting decisions, no scans of other entities or tiles. Everything that need not happen every tick (decisions, target searches, rerouting, transfers of goods at a destination, visibility, stats, statuses, hashing) runs in background layers at fixed tick cadences, deterministic and fair to all players; delays of a few ticks are fine when rates hold on average (an action every cooldown, a decision every K ticks) and are hidden by visuals later (loading, reading a map). Moving eventually beats never moving: a unit with no way to its target goes as near as it can or waits and retries, it is never stuck for good.

**Target architecture.**
- *Movement orders* (unit state columns, authoritative, snapshotted): mode (stand, flow to a tile, chase a slot, hold, approach a building), destination tile and its flow field slot, flags (worker, flyer), wake tick. Events written by the movers: arrived, unreachable/stood, cooldown ended. Today these columns are a derived cache (a restoring peer starts with every unit disarmed, hence the equivalence rule); once they are snapshotted (target slots as unit ids) and the object movement code (`doMoving`, `followPath`, `_followNavNode`) is gone, a restoring peer resumes the same orders and the equivalence rule disappears.
- *Movers* (L0, parallel kernels over all units): flow following (done), chase and hold (done), path windows (kept only until the last A* paths are gone), separation (L1 job, done). No hand-backs: an exhausted order raises an event and the unit stands.
- *Brains* (L2/L3): per unit a decision at its cadence ((tick + id) % K) or at its next decision slot after an event; decisions issue movement orders. First as batched object code with O(1) lookups (opportunity tables, nav nodes), then ported to typed jobs on the helpers by area: worker logistics (a typed state machine: carry, cooldown, target, destination; transfers committed as resource events), combat targeting and firing, buildings.
- *Opportunity tables* (L3): per owner and worker type, work sites (construction, repair, queues to pay, research, salvage marks, mines, farms, spawners for drop-off and gold) kept per region of the work-version grid; rebuilt for dirty regions (the existing work-version bumps) at a fixed cadence; each region holds its nearest few sites; a worker's search is a table read plus an O(1) validation (fallback: wait for the next build).
- *Routing* (no search ever on the tick path): every unit and worker uses the flow navigation (`navPathTo`: a nav node toward the target or the open tile nearest it). A route into a wall the navigation predates detours around it (`simNavDetour`, done); an unreachable destination: workers stand and their task looks again on its check ticks (done); planned: the closest reachable tile per (source component, destination), computed in the background from the cluster graph, so units move as near as they can instead of waiting.

**Done this round** (measured on the 1000 map, HELPERS=7): base p50 290 -> 223 ms (gameTick mean 292 -> 200), ACTIVE p50 430 -> 377 ms (unit pass 171 -> 111 ms):
- Separation contacts as a same-tick background job during the unit pass (helpers; the simulation thread waits only at the commit).
- The unit pass walks an activity list (units the movers did not handle) in the exact shuffled order.
- Visibility: units' coverage recomputed every tick from the columns (seed kernel + area-graph spread, ~2 ms); the incremental unit hooks, the unit-phase hold and window zones are gone (buildings stay incremental); the mover bookkeeping lost its zone events.
- Workers: actions wait for the transfer cooldown with nothing looked at, and a standing worker is parked until the cooldown ends; walking workers skip check-tick hand-backs while it runs; check ticks every 32 (was 8); workers' A* paths armed in the kernel; worker routing is flow navigation only (no A*, no geometric fallbacks, no spawner route cache); a worker on an unreachable flow stands instead of re-routing every tick; spawner and salvage-mark indexes rebuilt only when their membership changes.

**Next, in order** (each measured on base, ACTIVE and siege, and checked with equivalence and forced-path chaos):
1. Opportunity tables for idle searches (healer queues ~25% of worker AI, collectors 19%, builders 18%, researchers 10%, salvagers 9%), then the remaining per-action costs (a gather ~0.9 ms: profile).
2. Combat units moving without an armed order (`c1` ~4.9k updates a tick in ACTIVE) and hand-backs: the movers raise events instead.
3. Movement orders snapshotted; the object movement code removed (one path); worker logistics as a typed background job.
4. Hashing (~40 ms ACTIVE): column hashing as an L1 job; fewer object fields.
5. Building layer: statuses (`tickStatusEffects` ~17 ms), precomputed stats (~18 ms), barracks/spawners (~20 ms) at K-tick cadence with quiet buildings skipped.
6. Towers and projectiles (siege): due-shot scheduling (J1), structure broad phase (J2).
7. Closest-reachable routing in the background.

## 2. Common engine architecture and behavioral contract

Workers remain the first implementation priority, including fully employed workers. Normal combat units are a mandatory second workstream, not a residual fallback after worker optimization. Turrets, projectiles, lasers, and production receive explicit measurement and targeted algorithmic changes. A full typed-building migration is conditional on measured benefit; it is not a prerequisite for eliminating broad projectile scans or repeated queue calculations.

Additional source findings for this refinement:

| Current implementation | Remaining opportunity |
|---|---|
| `src/things/unit.js:638` still dispatches unhandled states through `Unit.update()` | Complete combat state coverage and measure fallback reasons |
| `simMoveTryHold` excludes forced targets, buildings, hold-position units, and larger ranges | Cheap typed target validation while attacks cool down |
| `combatScanRun` handles acquisition for idle/attack-moving states | Separate acquisition, engagement validation, chase, and firing workloads |
| `simMoveRun` and `combatScanRun` traverse the slot extent | Dispatch compact live/activity lists; measure fragmentation and preparation cost |
| `src/things/projectile.js:39` scans building collections for each surviving shot | Local structure collision queries, preserving collision priority |
| `src/things/tower.js:221` already uses area-indexed target searches | Due-shot batching and shared area traversal, not another global target index |
| `src/things/things_utils.js:6` tests laser pairs across the tower collection | Owner/row/column indexes and local connection invalidation |
| Laser unit hits use a broad circular query around a thin beam | Conservative strip broad phase with the existing exact hit predicate |
| `src/things/barrack.js:85` recreates normalized queue fronts and updates progress repeatedly | Normalize at mutation boundaries and refresh changed fronts |
| `processGlobalSpawnerQueue` already uses a heap | Avoid rebuilding readiness every tick; preserve the existing scheduler policy |

These are inspected code paths, not measured cost rankings. Some optimizations already exist: shared unit columns, status/movement/acquisition kernels, indexed turret targets, indexed laser structure candidates, compact unit removal, and heap-based production. Extend those implementations instead of counting their benefits a second time.

### 2.1 Authoritative state and a field manifest

Continue the migration to authoritative typed columns. Do not build a second full state representation that must be synchronized from objects every tick.

Add a declarative field manifest describing:

- Numeric type and default.
- Gameplay identity versus local slot identity.
- Snapshot encoding.
- Hash coverage.
- Relevant invalidation categories.
- Whether the field is gameplay state, derived state, or presentation state.

Generate or initialize accessors, serialization bindings, and debug validation from this manifest. Keep hot kernels explicit; avoid a generic field interpreter inside unit loops.

**Reason:** adding a worker deadline or task-generation field in several handwritten places invites missing snapshot/hash coverage. Conversely, blindly serializing every object property preserves unnecessary implementation state.

Use:

- Float64 for existing gameplay arithmetic.
- Integer columns for bounded indices, flags, enums, and local generations.
- Stable entity IDs for external identity.
- Slot-plus-generation handles internally.
- Explicit representation where absence, null, an empty route, and a valid route have different meanings.

Do not infer that all identifiers fit signed 32-bit integers.

`Unit` and building objects remain adapters during migration. Ordinary simulation, hashing, and frame preparation must stop traversing their property accessors.

### 2.2 Separate execution order from gameplay order

Maintain:

1. Canonical entity order, preserved by snapshots and relevant to deterministic priority.
2. Local packed slot order, chosen for efficient execution.
3. Spatial order, chosen for neighborhood access.
4. Per-phase activity lists.

Packing or slot reuse must not change gameplay priority.

Generate the existing shuffled-block priority using typed indices. Use that priority only where visiting order currently decides a conflict. Preserve explicit rules such as lower-ID reservation precedence and manual assignment overrides.

### 2.3 Activity lists and compact outputs

Maintain reusable lists for:

- Live units.
- Movers.
- Combat decisions.
- Active status effects.
- Due worker operations.
- Assignment and route recovery.
- Spatial/visibility changes.
- Spawn/death events.

Use membership indices, stamps, or bitsets to avoid duplicate enqueueing. Rebuild derived lists from authoritative state after restore.

Keep simple contiguous scans when they are cheaper than maintaining another index. The target is expensive redundant work, not an arbitrary prohibition on O(N) loops.

Helpers emit compact typed outputs using per-job counts, prefix sums, and scatter. Do not scan historical slot capacity afterward to find a handful of events.

### 2.4 Revised phase contract

The new deterministic simulation revision uses these boundaries:

1. Commands and scheduled world/navigation preparation.
2. Due statistics, visibility, and existing tower/projectile phases.
3. Status processing and immutable unit-decision inputs.
4. Parallel combat, worker, and movement decisions.
5. Assignment/reservation resolution.
6. Movement, chargeable transitions, arrivals, and floor interactions.
7. Combat resolution.
8. Worker/economic operations.
9. Lifecycle, separation, production, and maintenance.
10. Hashing and publication.

Rules:

- Commands retain their admitted tick.
- Newly spawned units begin acting at the existing next-unit-phase boundary.
- Navigation requests retain explicit readiness ticks.
- Combat resolves before worker work.
- Work against a target destroyed during combat is rejected before consuming pending material.
- Previously purchased material follows existing storage/clearing rules; no new refund behavior is introduced.
- Admitted attacks may resolve after their attacker dies during interaction commit.
- Retaliation affects the next decision phase.
- Research and construction changes affect subsequent phases and the next decision snapshot.
- Helper completion order never decides outcomes.

### 2.5 Preserve building and projectile sub-phases

The phase contract also needs an explicit building/projectile sub-order. Keep tower status and laser/shot actions before projectile advancement; projectiles created by towers participate in that tick's projectile phase. Keep barrack and worker-spawner status/construction/production processing after units, with global spawning afterward. A single universal status pass would change when newly applied building effects act.

Tower actions currently observe earlier tower actions, and projectiles run in reverse array order. Preserve those dependencies unless a separate simulation-revision change explicitly replaces them. Helpers may prepare conservative candidate sets and geometry, but ordered commit must revalidate candidates after prior damage/destruction. If a first candidate disappears, continue the ordered search rather than discard an otherwise valid shot or collision. Restoring a snapshot must reconstruct this order, including active projectile order.

### 2.6 Classify each kernel by mutation safety

Use two kernel categories:

**Pure output kernels**

Read immutable inputs and write owned outputs. Target search, work proposals, pair geometry, hashing, and frame encoding belong here. These can be retried before commit.

**Owned-state kernels**

Update exclusively owned authoritative fields at a barrier. They require either reliable completion before publication or a recoverable input version.

Do not treat a partially executed in-place status/damage kernel as safely retryable.

Persistent buffers are rebound only at barriers. Buffer generations, overflow detection, helper failure, and output publication must be explicit. No truncation of attacks, work, or contacts on overflow.

Initially keep sequential phase barriers. Cross-tick pipelining is unnecessary complexity until the basic architecture meets its budget.

### 2.7 Define the read version and visibility of each mutation

An immutable decision view does not mean a single snapshot for the entire tick. Write a phase access table before moving work:

| Consumer | Required input/commit rule |
|---|---|
| Towers and lasers | Observe relevant preceding tower actions in canonical order |
| Projectile impacts | Observe preceding impacts and current target survival; preserve reverse projectile order |
| Unit statuses | Run after projectiles; capture the specified tick-start unit positions |
| Unit/worker decisions | Read a named post-status decision version, including the chosen position and stat versions |
| Assignment | Read current reservations; earlier resolved claims affect later eligibility |
| Movement and floor interactions | Commit transitions in defined priority; one mine can be consumed only once |
| Unit hit commit | Resolve admitted hits with live death/destruction checks |
| Economic operations | Revalidate target, task, queue, and material state after combat and earlier work |
| Production | Observe the completed economic phase and current population limits |

Specify target-position and attacker-position versions separately: current code sometimes combines a moved attacker with tick-start target coordinates. Do not describe all positions as one shared snapshot and accidentally change contact/range behavior.

Each extracted phase needs a small semantic table: inputs, allowed writes, events emitted, first consumer of each write, canonical priority, and retained legacy exceptions. Mark intentional changes from the interleaved legacy update as revision changes; algorithm-only transformations must still match their legacy oracle. The new serial implementation is the oracle only for those explicitly selected revision semantics.

Shared journals provide invalidation and accounting; order-sensitive combat/work events remain separate ordered streams. Coalescing a health change to its first and last value must not erase a death, heal eligibility transition, effect application, or temporary population release observed between them.

## 3. Optimization workstreams

### A. Active and idle worker execution

#### A1. Replace general worker updates with operation-specific execution

Represent:

- Assignment selection.
- Travel to work.
- Waiting for material/transfer eligibility.
- Performing work.
- Return/supply travel.
- Deposit/purchase.
- Recovery.

Traveling workers stay inside movement kernels. A typed validation stage checks target generation, reservation, task generation, destination motion, arrival, hold state, and route progress.

It should not call the complete worker state machine merely because eight ticks elapsed.

Assigned workers waiting for a transfer are still active workers. Store explicit next-operation deadlines and execute them only when due or invalidated.

Use a timing wheel with generation-checked entries and overflow support. Avoid accumulating superseded entries whenever the same deadline is rewritten.

Do not convert every timer indiscriminately. Attack cooldowns can be fractional; deadline conversion must preserve the tick on which eligibility changes and any remaining value visible to gameplay or snapshots.

#### A2. Keep profession operations compact

Helpers produce typed proposals; commit applies existing formulas:

| Profession | Main commit responsibilities |
|---|---|
| Collector | Exact extraction/generation, depletion, cargo, return and deposit |
| Builder | Material cost, construction, upgrades, stacking, repair and completion |
| Healer | Unit healing or queue payment, material and queue-generation checks |
| Researcher | Material readiness, stored trip work, shared-task progress and completion |
| Salvager | Exclusive destruction, refund calculation, cargo and deposit |

Group by actual conflict identity. Research groups are player-task groups, not merely building groups.

Preserve integer extraction, rounding, caps, existing excess-work treatment, material rules, and payment rules.

#### A3. Remove side effects from eligibility queries

The existing `_isResearcherTargetBuilding` can call `tryAdvancePlayerResearchTask`. It is therefore unsafe inside parallel searches.

Split this into:

1. A read-only eligibility query.
2. An activation request for candidates whose owner needs a research task.
3. A deterministic activation commit, once per affected owner/task transition.
4. Re-evaluation of affected candidate batches against the published task.

Apply the same audit to other apparent predicates and lookups. Classify helpers as pure queries or mutations rather than assuming their names reveal their behavior.

**Pitfall:** running the same mutating eligibility function on seven helpers can advance queues multiple times even if workers write distinct output slots.

#### A4. Maintain reservations and task indexes incrementally

Retain the existing maintained reservation table. Replace the lazy per-tick full-unit discovery in `_getWorkersWithTargetThisTick` and full-unit manual-conflict scans with maintained conflict indexes. The reservation array is allocated/reset on initialization and restore paths; do not claim its removal as a recurring tick saving.

Update on assignment, release, removal, target motion, ownership change, and manual override.

Preserve the current reservation key and conflict rules. Do not silently replace tile/profession semantics with a different owner/entity key.

Reservation records must remain authoritative where they outlive a worker’s current target pointer. Returning-worker and dead-holder cases require explicit representation.

Search candidates by region and profession. Share broad-phase ranges but preserve worker-specific scoring, task memory, eligibility, and ties.

A lost claim must not end the search solely because an implementation-local candidate batch was exhausted.

The current single reservation cell is keyed by tile/profession, while conflict checks also inspect owner and target holders. Query eligibility and `_setWorkerTarget` do not implement one interchangeable lower-ID comparator: the query may reject an existing claim before the setter's displacement rule is reached. Reproduce the call-path behavior in the serial assignment resolver, including manual overrides and returning-worker claims. Do not replace it with generic per-target auctions.

#### A5. Optimize healer candidate selection without changing its policy

The current system selects up to twelve damaged candidates per owner every ten ticks, ordered by health ratio and ID.

Preserve that policy initially.

Replace the object scan with:

- Typed per-chunk scans.
- A fixed-size local top-k structure.
- A deterministic merge of the chunk-local results.
- Stable-ID records for snapshot/hash state.

The global top-k is contained in the union of chunk-local top-k lists, so this transformation can preserve results exactly.

Health, max-health, death, and ownership changes must be reflected. A damaged-unit list can eliminate healthy-unit reads, provided it is maintained through all those changes and independently checked.

Do not assume thousands of healers can all receive distinct unit-healing targets under the existing candidate policy. Active-healer benchmarks must provide legal queue/work targets as well. Expanding the policy is a separate gameplay change, not a performance shortcut.

#### A6. Idle workers use the same machinery

Idle workers have no movement or due-work job. They retain:

- A future search deadline or work-change dependency.
- Status/damage processing when applicable.
- Collision/occupancy participation.
- Visibility, targeting, and hashing participation.

Fix the expired-retarget/backoff interaction so rejected searches leave a meaningful future deadline.

Coalesce work changes by affected region/profession. Avoid worker×target subscription matrices and global wakeups for every individual damage event.

Existing hold/stop behavior remains unchanged. No pause command is required.

#### A7. Parallelize candidate preparation without changing the ordered choice

`_pickDistributedWorkerCandidate` first accepts strictly lower scores, then handles scores within 1e-9 using the lexical key `targetType|gx,gy|id`. Its near-tie branch can replace the selected candidate without replacing the stored best score. This is an ordered fold, not a conventional total-order comparator; sorting, local top-k, or merging chunk minima needs a proof and cannot be assumed correct.

Prepare eligibility-independent geometry and scores in helpers, preserving canonical candidate sequence. Resolve reservation-sensitive eligibility and selection in an exact compact fold. Reuse candidate-key representations where useful, but preserve lexical ordering (for example, the text '10' sorts before '2'); numeric field sorting is not equivalent. Preserve the existing Number multiplication and conversion in the worker-specific score seed rather than substituting `Math.imul` without an equivalence check.

For contention, process bounded candidate pages with an explicit continuation cursor and fold state. Apply prior assignment effects at the defined priority point. If claims change, invalidate/re-evaluate affected eligibility; do not use a stale prefiltered list. A worker either finds the same eligible choice or proves the relevant candidate stream exhausted. Paging bounds memory, not gameplay search effort. Use a serial reference for lower-ID displacement, different owners sharing a reservation cell, two target objects on one tile, and moving healer targets.

#### A8. Turn work availability into shared regional inputs

`_workerWorkVerOf` currently folds regional versions separately for each worker, including regions around its profession-specific search origin and current position. Cache/deduplicate identical region-set queries per owner/profession and source version. Share that read preparation before attempting a reverse subscription index.

Separate three changes: candidate membership, candidate eligibility, and an individual claim/payment. A single payment or claim should not rebuild every profession's entire target set. Conversely, owner-wide research/resource changes may legitimately invalidate many workers and need one coalesced owner/profession event.

The builder cache currently scans structures and canonicalizes targets on tile-entity changes or after ten ticks. Maintain its active membership and canonical enumeration incrementally, but first specify whether new eligibility remains visible at the old refresh boundary. Immediate discovery of newly damaged/eligible targets is a behavior change if the old cache would not contain them yet. Live revalidation of existing candidates is a separate rule.

Define invalidation coverage from the actual search domain, including researcher-specific reach, mobile healer targets, area-range semantics, ownership, and alternate search origins. Never use a smaller geometric wake region than the query can inspect. Version/checksum equality alone is not an infallible proof of no change: use explicit epoch/generation rules and test wrap/reset, while retaining required periodic wakeups.

Measure failed searches, shared version-query preparation, conflict checks, and wake-to-success ratio. Mass completion, empty resources, and owner-wide changes must not produce duplicate wake entries or worker-by-target subscription storage. Keep a deterministic dense scan fallback when most workers are due; do not postpone legitimate work to smooth CPU usage.

### B. Economic operations and shared-resource reductions

Typed worker decisions are insufficient if commit still calls expensive object methods for every transaction.

Use a compact resource ledger containing owner, resource, priority, source, and fixed-point delta.

- Convert each delta using existing conversion rules before aggregation.
- Preserve intermediate eligibility checks.
- Preserve negative-balance behavior.
- Preserve resource high-water values.
- Aggregate presentation/accounting output afterward.
- Rebuild affected stat profiles once at defined boundaries.

For unconditional fixed-point deltas, use grouped sums and prefix summaries where required. For conditional operations, use compact ordered folds.

Keep numeric progress separate from consequences. Completion emits events for topology, task indexes, stat profiles, production, and presentation. Deduplicate those events before maintenance.

**Important consequence:** many research labs can share one task. Exactly-once task completion must be enforced even when proposals originate from different buildings and helpers.

### C. Effective statistics: reduce query work, not merely distribute it

The current large-batch path directly sums every rectangle in `SIM_KERNEL_EFF_COUNT`; it bypasses the overlap-aware prefix-table path.

Replace that threshold-based switch with a common query planner.

#### C1. Build typed query descriptors

For each due unit, produce:

```text
owner/type lane
x1, y1, x2, y2
destination output index
```

Group identical descriptors and evaluate each unique rectangle once. Scatter the integer answer to all consumers.

Use numeric keys or typed sorting; do not allocate string keys per unit.

#### C2. Choose exact algorithms from deterministic work estimates

Support:

- Direct summation for small or sparse queries.
- A summed-area table over a compact group bounding box.
- Tiled prefix tables for widely distributed queries whose union would otherwise force a large mostly unused table.

For tiled tables:

- Use fixed-size tiles, initially 32×32 spatial cells.
- Maintain block totals and local prefix tables for requested blocks.
- Answer interior whole-block regions through a coarse prefix table.
- Answer edge pieces through local block tables.
- Build/rebuild only tables required by that phase’s query set and changed counts.

Use the same formulas on all execution paths; these are exact integer counting methods.

The decision is based on estimated cells read/written, not on wall-clock timing or helper availability. Choosing a different implementation must not change the count.

#### C3. Separate stat profiles from scheduled mutations

`_refreshThingPrecomputedStats` still floors/clamps health on its unchanged-profile fast path.

Therefore:

- Cache/share profile computation.
- Retain scheduled health normalization and bookkeeping as a separate cheap typed pass.
- Preserve effective/base stack and level updates in their defined order.
- Recalculate profile membership only when relevant inputs change.
- Do not wake movers or workers when refreshed values are identical.

This prevents an optimization from inadvertently removing periodic gameplay behavior.

### D. Navigation: incremental topology and destination-driven computation

At 1000×1000, the current 32-tile clusters produce 1024 clusters. A full navigation rebuild performs destination searches for every cluster and reconstructs local fields broadly.

That can become a major active-economy cost as mines deplete and buildings change.

#### D1. Localize terrain-cost changes

The current wall-proximity cost depends on nearby walls within two tiles.

For each changed wall tile:

- Mark its two-tile cost halo.
- Mark affected clusters and border spans.
- Recompute only affected cost cells.
- Rebuild local exit fields and intra-cluster edges for changed clusters.
- Rebuild a neighbor’s boundary data when a shared border changes.

Give cluster-local exits stable identities plus generations. Do not globally renumber every exit after a local change.

#### D2. Build destination data for actual demand

Collect destination-cluster requests from authoritative route descriptors.

- Build destination rows for requested clusters.
- Deduplicate requests.
- Keep rows referenced by active routes.
- Retain a dense all-destination mode when most destinations are demanded.
- Both modes use the same costs and tie rules.

This primarily reduces unnecessary rebuild work when demand occupies only part of the map. It is not sufficient by itself for the all-workers-active case with destinations everywhere.

#### D3. Repair retained destination trees

For frequently used destinations, retain shortest-path distance and predecessor information:

- Edge decreases seed relaxations.
- Edge increases/removals invalidate affected predecessor subtrees.
- Seed invalidated nodes from valid boundary alternatives.
- Propagate until the result is stable.
- Preserve deterministic equal-cost tie-breaking.

When repair touches a substantial fraction of a tree, use full recomputation for that destination. This is an implementation fallback with identical results, not a different routing policy.

Cache these derived trees under an explicit memory budget. Active route descriptors remain valid if a derived tree is evicted; reconstruction cannot change route readiness or results.

For validation, compare every incremental graph result against full recomputation on randomized topology changes.

Implement navigation in escalating steps: deduplicate requested destinations, avoid unaffected local rebuilds, then assess retained-tree repair. Dynamic shortest-path repair is optional until profiling shows full recomputation of the demanded rows still exceeds budget. Equal distances are not sufficient validation: next-hop/predecessor choices, unreachable markers, route sequences, and readiness must agree too. Preserve row identity separately from local storage layout so incremental exit allocation cannot redefine tie order.

#### D4. Publish complete navigation generations

Do not publish a mixture of new local fields and incompatible old destination rows.

A generation consists of compatible walls, costs, exits, graph data, and required route data. Its publication follows deterministic simulation stages.

Until publication:

- Existing routes remain associated with their installed generation.
- Live wall checks prevent illegal movement.
- Pending field readiness remains explicit.
- No peer starts a route earlier because its cache happened to contain a result.

Current rebuilds use `NAV_BUILD_SLICES` and deterministic publication stages in `navTick`. Preserve the logical installation tick even when optimized work finishes early. A cache miss, eviction, slow helper, or restore can increase wall-clock work, but cannot move logical readiness on one peer. Collect newly requested destinations during an in-progress rebuild and define how each joins the next generation before publishing it; copying only the request set from build start is insufficient.

#### D5. Keep A* economics independent

Preserve the separation between pathfinding CPU budgets and A* stockpile charges.

Movement currently continues with insufficient stockpile, records an indicator, and may produce a negative balance. Do not turn that into a movement prohibition.

Use a compact transition ledger and preserve:

- Per-step conversion.
- Duplicate-transition suppression.
- Per-unit insufficient-balance indicators.
- Owner/type accounting.
- The distinction between route travel and collision displacement.

### E. Normal combat units: decisions, movement, attacks, and neighborhood data

Complete typed handling of target validation, acquisition, cooldowns, forced targets, structures, holds, statuses, chase, leash, and drive-by attacks.

Do not treat “has a status,” “target is a building,” or “visual target differs” as a reason to invoke the full object update.

#### E1. Read a small immutable decision view

Prepare only the cross-unit values queries need:

- Position.
- Owner/alive state.
- Relevant radii and visibility.
- Targetable flags.
- Stable identity.

Reuse spatially ordered arrays rather than repeatedly jumping from spatial entries to large unit records.

Do not duplicate all authoritative columns.

#### E2. Share traversal, not approximate answers

Group nearby queries by compatible owner/range/visibility state.

- Reuse candidate cell ranges.
- Compute cell bounds once.
- Skip cells whose conservative lower distance bound cannot improve any query in the batch.
- Evaluate final targets individually with exact rules and ties.

A shared candidate shortlist is not automatically a valid nearest-target result for every attacker. Continue searching when bounds cannot prove completeness.

Cache “no hostile candidates” only while all relevant spatial/visibility versions remain unchanged.

#### E3. Simplify hostile summaries

`_simMoveBuildHostile` currently sums other players within each player loop.

Compute total unit occupancy per block once, then:

```text
hostile units for owner = total units − owner units
```

Combine with the existing structure-hostility rules. Keep ownership semantics unchanged.

Deduplicate dirty structural tiles before refreshing their block contributions.

#### E4. Replace common combat fallback states with explicit jobs

Treat all non-worker types as in scope, including `norm`, ranged attackers, flying units, scouts, kings, and special attack styles present in the workload. Build a state-coverage matrix before migration:

| State | Required work |
|---|---|
| Idle without a target | Due acquisition, floor refresh, and relevant change checks |
| Moving | Navigation/steering, floor interaction, and eligible drive-by attack |
| Attack-moving | Acquisition, movement, and engagement transitions |
| In-range engagement on cooldown | Cheap target validity/range/visibility checks and deadline eligibility |
| Ready to attack | Target validation, attack admission, cooldown/flash updates, hit intent |
| Chasing | Target position/visibility, leash, direct steering or route request |
| Holding position | In-range acquisition/attack without chase |
| Forced unit/building target | Explicit lock, last-seen behavior, and target-specific validity |
| Scout/special behavior | Its explicit destination/attack jobs and deterministic random draws |

Keep acquisition, target validation, route recovery, attack readiness, and floor effects separate. A cooled-down attacker does not require full acquisition every tick, but a moving target can leave range or sight before the next shot. An attack deadline alone is insufficient to sleep the whole unit.

Measure fallback counts and time by reason: target kind, forced order, range, hold, path state, floor event, and special behavior. Common states must execute without the broad object state machine. Rare adapters must have a documented reason and measured cost; a high nominal kernel-coverage percentage is not an acceptance result.

Preserve acquisition cadence, current target retention, target-specific ties, forced-target contact exceptions, last-seen pursuit, attack-moving resumption, and the eight-tick automatic structure-to-unit reconsideration. Do not introduce less frequent scans merely to reach a performance target.

#### E5. Complete chase and movement handling

Share movement infrastructure with workers. Use typed descriptors for direct chase, ordinary/shared routes, fallback routes, flying movement, arrival, and blocked-tile recovery. A target position change should update steering; request a new route only under the existing route-validity and chase rules.

Deduplicate compatible path queries without merging distinct destination/readiness/owner-permission semantics. Retain path CPU budgets, resource charges, and command responsiveness. Do not give nearby combatants the same route merely because they share a target.

Use compact movement and transition outputs instead of scanning all historical slots to find movers and charges. Measure lists, compaction, spatial writes, visibility changes, and A* charge commit within movement cost. A shared cache's invalidation must not wake every combatant because one unrelated stat profile changed.

#### E6. Separate active statuses from ubiquitous bookkeeping

The existing status kernel copies tick-start positions and handles damage effects, timers, attack flashes, teleport visibility, and worker transfer cooldowns in one population pass. Merely changing it to a status-active list would drop necessary work for unaffected units.

Split or fuse cheap position capture with a pass that already visits the required live units. Track damage-effect jobs and due expirations separately, including wet/frozen interaction and watch visibility expiration. Preserve the exact effect decrement/damage order and fractional cooldown eligibility. Keep attack flash and other observable countdowns equivalent through typed timers or explicitly defined deadline accessors.

Emit compact status/death/visibility outputs directly. Today a nonzero status-event count can trigger a second scan across an entire 8,192-unit chunk; replace that discovery scan with counted output ranges. Use a contiguous scan when active-effect density makes it cheaper than maintaining sparse jobs.

#### E7. Make attack commit small without assuming damage commutes

The existing unit hit queue is already ordered, but stores object references and calls object-oriented hit handlers. Move its target/attacker identity and necessary attack data into compact typed intents. Define which values are captured at admission and which are read at commit; preserve the selected phase contract rather than accidentally freezing currently live values.

Preserve ram self-damage, admitted attacks after attacker death, resistance/status formulas, first lethal hit, damage attribution, retaliation priority, target destruction, and shared-floor/entity identity. Handle unit and building targets through explicit branches. Do not replace sequential floating-point damage with a sum: that can change rounding, death cutoffs, effect application, and attribution.

Start with a tight ordered typed fold. Parallelize independent target groups only after proving they do not share retaliation, destruction, resource, or lifecycle side effects. Keep an ordered consequence stream where those dependencies exist. This is especially important for many attackers focusing one target: measure the unavoidable hot-target serial fold separately.

### F. Separation: pair-once geometry with exact directional effects

The current kernel visits a contacting pair from each participating unit. This repeats distance and overlap computation.

After measuring the existing gather path and its preparation/commit costs, prototype a pair-once path for dense interactions:

1. Enumerate unordered cell pairs.
2. Split large cell pairs into bounded blocks.
3. Enumerate unordered unit pairs within those jobs.
4. Compute distance and overlap once.
5. Compute each endpoint’s correction independently.
6. Emit bounded per-job endpoint accumulations.
7. Reduce by endpoint before the existing correction/quantization stage.

Retain the current per-unit gather path for sparse interactions where pair-output reduction would cost more.

The partition between paths must assign each interaction exactly once.

#### Critical correctness details

- Correction shares depend on which endpoint moved and which participates.
- Exact-overlap directions depend on each unit’s own movement.
- `Math.round(-x)` is not always `-Math.round(x)`.
- Therefore, the second endpoint cannot simply receive the negated first correction.
- Integer accumulation is order-independent only while values remain within exact integer range.
- Maximum overlap and contact count must match the scalar reference.
- Preserve collision layers, owner padding, wall handling, and quantization.

Do not store one large object or record per contact. Dense overlaps could otherwise create a memory explosion. Use bounded tile/block-local partials.

No contacts are discarded to meet a performance target.

Keep gather as the production reference until a bounded prototype wins on complete separation time, including pair enumeration, endpoint reduction, scratch traffic, and helper waits. Do not require pair-once merely because it halves geometry calculations; its reduction cost can exceed that saving. Enable it only for a deterministically selected density regime that passes exact equivalence and peak-memory gates.

### G. World change journal and maintenance

Introduce one reusable change journal produced by authoritative commits.

Categories include:

- Entity spawn/death.
- Position/area crossing.
- Health/max-health change.
- Tile type/owner/entity change.
- Queue/task generation change.
- Stat-profile change.
- Topology change.
- Presentation-only change.

Each consumer has a defined phase and watermark. Coalesce repeated changes while retaining the first old value and final new value where delta accounting needs both.

Consumers include reservations, visibility, spatial summaries, navigation, population capacity, healer candidates, rendering, and snapshot support.

**Do not use this journal as the sole correctness basis for state hashing.** Hashes still periodically read authoritative values.

Additional maintenance changes:

- Death queues replace broad death discovery.
- Population capacity updates follow house contribution changes.
- Adjacency uses deduplicated dirty tiles and numeric signature IDs.
- Local adjacency work must not automatically imply a whole-world path invalidation.
- Preserve upkeep timing and accounting.
- Batch creation/removal without repeated list splicing.

Independent reconstruction tests must compare all maintained indexes with a fresh rebuild.

#### G1. Finish the spatial build instead of adding another spatial copy

`_spatialIndexRebuildParallel` already generates keys and stably sorts by chunk and by area. It then walks both orders on the main simulation thread to fill object arrays, slot/key arrays, range metadata, and owner counts. Measure these serial tails independently from sorting and worker time.

First make typed slot ranges the direct query interface. Migrate remaining object-query consumers incrementally; build an object view only where it is still needed. Parallelize boundary detection/range metadata and per-area owner counts with uniquely owned ranges or bounded local reductions, avoiding an atomic increment for every entity. Keep canonical within-cell order wherever first-match queries expose it.

Spatial sorting currently returns reusable scratch storage. Consumers must finish or retain their needed order before another sort reuses that storage. Explicit ownership is also required if per-phase views remain alive across later rebuilds.

Prefer a proven full packed rebuild at high movement density and local maintenance at low density only if it wins after ordering and journal cost. Compare deterministic estimates of entities moved, affected cells, and ordering work; both algorithms must expose the same logical membership/order. Never introduce a large per-helper histogram over every map cell and owner without including its memory and clearing cost.

Keep live count summaries and frozen query membership distinct. Queries against older membership need a conservative displacement/radius bound; ordinary speed is not a valid bound for teleports or other discontinuous moves. Such transitions require the phase's explicit spatial refresh or an exactly queried exception list. Test area-border movement, separation displacement, teleports, and newly spawned entities at every consumer boundary.

### H. Hashing and snapshot repair

#### H1. Typed rolling hash

Keep the previous direct-column plan:

- Stable-ID unit shards, ten slices.
- Three rotating additional-field groups.
- Current-region tags for repair localization.
- Canonical references and field encodings.
- Deterministic per-region reductions.
- Strict full-state debug hashing.
- Owned history records rather than reusable scratch arrays.

Scheduled reads must detect authoritative mutation even if a dirty hook was missed.

Hash shared route definitions on their audit schedule, not merely an indefinitely cached digest.

#### H2. Region-indexed snapshot extraction

Maintain an entity-region index from authoritative position/placement changes.

For a regional patch:

1. Enumerate entities directly from selected regions.
2. Add explicit shared dependencies.
3. Serialize stable-ID references.
4. Include relevant reservations, task state, and canonical order information.
5. Resolve outside references through the shared entity registry.

Dependency closure must include player research state and associated labs where shared task identity requires it.

Avoid scanning all units once per selected region or rebuilding broad membership maps for each patch.

#### H3. Remove hidden full-map navigation scans from small patches

Navigation snapshot state currently derives differences by scanning wall arrays.

Maintain explicit sparse differences between:

- Live walls.
- Installed navigation walls.
- An in-progress build’s walls.

Update these at topology mutations and generation publication. Encode their canonical sorted contents.

On restore, rebuild derived navigation data from the recorded semantic generation and progress state. Restore cannot pretend an unfinished build was already usable.

#### H4. Encode a coherent tick

For asynchronous encoding:

- Freeze/copy the selected authoritative data at the patch tick.
- Serialize that retained version afterward.
- Do not traverse a live mutable world over multiple ticks.
- Bound in-flight snapshot memory.
- Preserve host/guest patch-tick behavior.

Hashing’s 2 ms ordinary budget does not imply that full-world serialization is free. Measure full restore, regional repair, and resync bursts separately.

### I. Frame publication and browser integration

This is additional to the supplied headless tick target. It must be addressed so faster simulation does not expose a larger browser bottleneck.

#### I1. Remove the million-cell comparison

`simFrameEncodeState` currently compares every cell each frame.

Use the world change journal:

- Send an initial complete grid.
- Thereafter publish deduplicated changed cells.
- Preserve generation/reset markers.
- If intermediate frames are coalesced, retain changes until the receiver’s known version is covered.
- Handle restore with an explicit new epoch/full replacement.

Do not clear grid changes merely because one frame was constructed.

#### I2. Encode units directly from authoritative columns

The current frame format uses 108 bytes per allocated unit slot. At 200,000 slots, that is about 21.6 MB per frame, or 432 MB/s of output writes at 20 publications per second, before source reads and page-side work.

Separate:

- Static or infrequently changing unit metadata.
- Dynamic pose/health/activity columns.
- Membership/order changes.
- Selected-unit details.

Encode dynamic columns in helpers without the current preliminary object passes for flags, target positions, worker state, and activity.

Generate activity from explicit state and event timestamps. Preserve special animation behavior rather than approximating it from command state alone.

#### I3. Bound publication pressure

Use explicit FREE/WRITING/READY/READING buffer ownership.

- Never overwrite a buffer the page is reading.
- Coalesce obsolete visual frames when the page falls behind.
- Do not drop gameplay events, authoritative ticks, command acknowledgments, or required deltas.
- Keep the latest complete state and enough interpolation history.
- Report publication time and page-application time separately.

Presentation coalescing must not change simulation results or appear as a simulation speedup.

### J. Turrets and projectiles

#### J1. Schedule due turret actions, retaining exact policy

Separate construction checks, active statuses, ordinary shot readiness, and continuous laser work. Cloud towers should not execute ordinary firing logic. A cooling ordinary turret needs a due-shot entry, plus any independent status/construction work; do not rebuild all ready lists through objects every tick.

Preserve the current cooldown edge: when `cd > 0`, the update decrements and returns even if it just reached zero. The next update can shoot. An unsuccessful acquisition also sets the cooldown in the current code. Deadlines must reproduce both cases and snapshot-visible values.

Batch due turrets by compatible owner/source areas/range and read compact unit/structure candidates. Cache topology-dependent area sets separately from population- and status-dependent answers. Turrets currently prioritize a valid preferred target, then unit categories (unaffected, already affected, immune), then towers, traps, producers, and other floor items. Unit ties follow existing traversal order; structure helper ties use tile index. Do not replace all of these with one nearest-ID policy or add unit-style visibility restrictions to turret queries.

Share broad-phase traversal while evaluating each turret's exact score. Status changes can move a candidate between priority categories even when it has not moved. Cache validation therefore includes status/ownership/liveness/range dependencies, not just spatial membership. Remove avoidable square roots only after checking equivalence at equal-distance and floating-point boundaries.

#### J2. Eliminate projectile-by-building scans first

Each projectile currently moves, decrements life, checks nearby units, scans towers/barracks/spawners in list order, checks its aimed floor tile, and only then checks expiry/range. With P projectiles and B buildings, the building portion can approach O(P x B) candidate visits.

Reuse or extend the existing structure spatial index to enumerate only cells intersecting the projectile's 18-pixel building-hit neighborhood. Preserve unit-before-building priority, building collection/list order, and aimed-floor-item handling. A projectile's hit target is not necessarily the geometrically nearest candidate. Keep the current endpoint collision rule; swept collision would be a separate gameplay change.

Keep existing source and floor-target coordinate/owner resolution semantics, including replacement at a tile. A new generation handle must not silently change which replacement entities those references resolve to.

Advance projectiles in typed arrays if profiling justifies migration. Helpers can calculate next positions and conservative collision candidates; resolve dependent impacts in canonical reverse-projectile order against live damage/liveness. Preserve status combinations, splash exclusion of the direct target, turret immunity, and hit-before-expiry behavior.

Replace per-expiry `splice` with stable compaction after ordered processing. Keep survivor order and same-tick newly fired shots. Reuse storage with generation-checked handles if pooling is introduced; never let slot reuse redirect an outstanding intent. Add projectile state and canonical order to manifest, hash, snapshot, and frame tests when migrated.

### K. Laser topology and continuous damage

#### K1. Index connection candidates by owner, row, and column

`recalculateLaserConnections` loops over the tower collection's pairs and scans intervening wall tiles. Build row/column indexes of lasers, enumerate only compatible collinear candidates, and answer wall-between queries with row/column wall aggregates or another measured exact index.

Retain all legal links, not just nearest neighbors. Preserve minimum gap, the minimum of both effective levels as the reach limit, wall blocking, construction/effective-level behavior, and existing adjacency-list order where it affects damage sequencing.

Placement, removal, ownership, level, and wall changes invalidate affected rows/columns or spans. Deduplicate invalidations up to a defined boundary, but publish before the first action that must observe the change. Do not delay a mid-phase topology change that currently affects a later laser.

The target cost is relevant candidate pairs plus emitted links, rather than all tower pairs. Dense legal link graphs still require proportional storage/work; no links may be omitted for a benchmark.

#### K2. Query a beam strip rather than its enclosing circle

Laser-to-building candidates already use a narrow spatial query. Extend equivalent broad-phase efficiency to units: enumerate cells intersecting the axis-aligned segment expanded conservatively by unit radius and beam width. Account for large radii, spatial-index age, and movement margins. Run the current exact per-unit hit predicate afterward.

A long thin beam's current circle can collect many unrelated units. Measure visited cells/candidates versus actual hits. Reuse static beam geometry until endpoints/links change. Process canonical links and victims in the defined order; overlapping beams still apply every legal contribution each tick. Preserve resistance, damage divided by 60, death/destruction, retaliation, and laser activity signals.

### L. Production and other buildings

#### L1. Refresh production on actual changes

Producer updates repeatedly compute spawn cooldown and normalize the queue front. Cache cooldown by the exact formula dependencies (owner, building/unit type, base level, research/config version). Normalize queue entries on enqueue, edit, restore, and promotion to front. Update payment-derived progress only when payment, front identity, cooldown, or eligibility changes.

`spawnTimer` is derived from paid energy, not an independently advancing production clock. Do not replace it with time-based production. Healer payments, research completion, and queue commands must wake the correct producer in the correct phase.

Keep the current ready heap as the reference. If scan costs are material, maintain generation-checked ready membership and defer population-blocked owners until a relevant population/capacity/eligibility change. Preserve global ready order and collection-order ties, disabled queues, failure behavior, front promotion, and the existing 2,048 successful-spawns-per-tick limit. Restored heaps are derived; authoritative ready order and counters survive snapshots.

Do not add a new budget that reduces legal spawning. Batched creation must preserve stable IDs, canonical append order, rally paths, and the tick on which spawned units first act.

#### L2. Make quiet buildings cheap

Track construction threshold checks, active statuses, changed stat profiles, queue changes, upkeep, and destruction independently. Damage, healing, construction, ownership, and upgrade events schedule necessary work; a quiet building does not need all of its general update every tick.

Retain periodic gameplay normalization and the different status boundaries for towers and producers. Upkeep aggregation must preserve contribution eligibility, timing, conversion, and intermediate balances. Keep traps in unit floor-interaction jobs with tile-change/periodic-refresh handling; do not introduce a full trap sweep.

Use the shared journal for housing capacity, research/lab eligibility, portals, visibility, adjacency, and repair indexes. Implement typed hot building fields only when they remove measured traversal or commit costs. Reuse object adapters for cold metadata.

### M. Execution overhead, memory, and recoverable jobs

#### M1. Choose task granularity by work, not just entity count

Several existing kernels dispatch fixed entity ranges (2,048, 4,096, or 8,192 entries). Equal entity counts can contain radically different numbers of candidates, links, or contacts. Retain dynamic task claiming, but create bounded spatial/candidate blocks for dense jobs so one hotspot cannot hold the entire barrier.

Use deterministic work estimates for dense versus sparse paths and dispatch thresholds. Benchmark the serial path for tiny jobs and avoid a helper barrier when it costs more than the work. Fuse compatible cheap passes only when their input/output phase contract permits it; do not fuse across gameplay visibility or resource boundaries.

Measure preparation, dispatch, main-participant work, helper work distribution, wait time, compaction, and commit. Main-participant elapsed time already overlaps helper work; do not add every helper's CPU time to wall-clock tick time. Instrument detailed counters only in diagnostic runs and compare against the low-overhead timing build.

#### M2. Make helper failure recovery concrete

Today `simParallelRun` waits for an aggregate completed-chunk count. A helper failure after claiming work can leave that count short; the error handler only logs the error. A partially mutated authoritative chunk cannot be safely processed again as if it were untouched.

Use run generation plus per-job claim/completion state, and publish outputs only for a completed compatible run. For pure kernels, discard/recompute uncommitted outputs after fencing the failed generation. Do not reissue an overdue claim while its original helper can still write into the same storage. Terminate or otherwise prove quiescence of old writers, or use isolated generation-owned output buffers.

For owned-state kernels, choose explicitly between staged replacement values committed once, or a retained recoverable input version covering every mutated field. Prefer staged status outputs for the first recoverable implementation if their measured bandwidth cost fits. Never recover by replaying damage, cooldown decrements, resource debits, or effects against partially updated state.

The tick commits, hashes, acknowledges commands, advances its tick counter, and publishes only after all required phases succeed. A watchdog detects infrastructure failure in wall-clock time; it must not convert failure into different gameplay deadlines or skip jobs. If recovery is impossible, report a failed tick and restore a known coherent version rather than continue from partial state. Test failure before claim, after claim, during output, during owned writes, and after completion but before publication.

#### M3. Budget bytes and lifecycle work before allocating more columns

For every persistent/scratch structure, record bytes per live entity, allocated slot, map cell, owner, destination, job, and in-flight version. Also record bytes read/written per tick and peak old-plus-new storage during growth, restore, and navigation publication.

For scale: one Float64 column over 200,000 slots is 1.6 MB; a 16-entry Int32 route window is 12.8 MB at that size. A million-cell Int32 plane is 4 MB before multiplying by owners, types, or helper count. These are arithmetic illustrations, not measured total allocations. Existing columns and indexes must be inventoried before adding replacements alongside them.

Current unit allocation grows and rebinds all columns, while reclamation checks sliced slot ranges and detaches dead objects' numeric fields before reuse. Pre-size known benchmark populations and reserve capacity at safe barriers; also test production crossing capacity boundaries without preallocation. Use live/activity indirection first to eliminate high-water scans. Only compact physical slots if measured savings exceed relocation and reference-repair cost.

Removal queues should carry slot plus generation and retire slots only after all current intents/readers finish. Preserve detached-object semantics while legacy references remain; do not discard their last values or reuse an address beneath a queued hit. Generation reset/wrap and same-tick restore require an epoch as well as a slot number. Derived local slot generations do not become gameplay identity or enter hashes merely because they are convenient.

Bound and release candidate pages, journal segments, detached references, helper buffers, and old navigation/frame generations. Track object allocations and retained capacity after a grow-then-shrink battle. Hard memory exhaustion is an explicit failure/recovery condition, never permission to truncate contacts, candidates, attacks, or worker output.

## 4. Implementation order, interfaces, and risks

### 4.1 Internal interfaces

Introduce narrow interfaces around the existing functions:

- `simBuildWorkLists(context)`
- `simWorkerValidate(context, jobs, output)`
- `simWorkerAssign(context, requests, output)`
- `simWorkerCommit(context, intents)`
- `simCombatDecide(context, jobs, output)`
- `simCombatCommit(context, intents)`
- `simProjectileAdvance(context, jobs, output)`
- `simProjectileCommit(context, intents)`
- `simTowerDecide(context, jobs, output)`
- `simLaserTopologyCommit(context, changes)`
- `simLaserHits(context, jobs, output)`
- `simProductionCommit(context, changes)`
- `simStatsQueryBatch(context, queries, output)`
- `simWorldChangesCommit(context, changes)`
- `simHashTick(context)`
- `simPublishFrame(context)`

`context` identifies the tick and compatible state, spatial, stat, and navigation generations.

The names are proposed interfaces; their essential contract is explicit read versions, owned outputs, and defined commit boundaries.

### 4.2 Revised delivery sequence

| Stage | Work | Required gate |
|---|---|---|
| 1 | Measurement corrections, state coverage, and pure/mutating helper audit | Account for all tick time; separate worker, combat, tower, projectile, laser, and production cost |
| 2 | Field manifest, handles, canonical order, activity lists, journal | Serial/snapshot invariants pass |
| 3 | Exact batch statistics and typed healer top-k | Scalar equivalence, including health normalization |
| 4 | Worker travel, deadlines, assignment and economic commit | All professions sustain legal work simultaneously |
| 5 | Complete normal-unit combat, chase, cooldown validation, statuses, and typed hit commit | No common state falls back to broad object updates; useful attacks and movement preserved |
| 6 | Projectile structure broad phase and stable compaction; due-turret queries | Exact collision/target priority, same-tick shot motion, and status ordering |
| 7 | Navigation demand/local rebuilds; retained-tree repair only if still justified | Adopted incremental paths match full recomputation, ties, and readiness |
| 8 | Laser topology/strip queries and changed-only production, where measured material | Link/hit equivalence; exact production order and throughput |
| 9 | Spatial/visibility/lifecycle cleanup; pair-once separation if its complete measured cost wins | Exact query/contact references and bounded peak memory |
| 10 | Typed hashing and indexed repair for all migrated entity types | Corruption/repair/restore tests |
| 11 | Direct frame encoding and grid deltas | Ownership and dropped-frame tests |
| 12 | Whole-system optimization and acceptance | Complete tick, active-economy, combat, and building-heavy acceptance |

Preserve the current implementation as the baseline, including any user changes present when implementation starts. The working tree was clean at this refinement's initial inspection.

The table expresses dependencies and priority, not a requirement to postpone small independent gains. Once phase/order tests exist, the local projectile structure query can be implemented early without migrating all buildings. Advance larger building migrations only when representative measurements show that they compete with the remaining worker/combat work. An illustrative triage threshold is 5% of complete tick time or recurring tail spikes; it is not a correctness criterion or a reason to ignore a structure-heavy workload.

Deliver the architecture in working slices, not one all-or-nothing rewrite. Extend the manifest/journal only for each migrated field and consumer, retain a serial execution path, and remove duplicate old preparation when its last consumer migrates. Do not require a complete universal schema or every activity index before optimizing worker execution.

The first reviewable implementation slices are:

1. **Establish comparable measurements and semantic oracles.** Recover the exact baseline fixture/revision behind the inherited numbers; label them historical until reproducible. Instrument worker states, combat fallback reasons, serial spatial tails, projectiles, production, and job waits. Use the same field/hash/publication coverage on both sides.
2. **Remove repeated worker preparation.** Maintain target-conflict membership; share repeated work-version queries; preserve candidate folding and reservation semantics. Verify moving targets and complete legal work cycles before adding parallel assignment.
3. **Migrate one worker operation end to end.** Include due scheduling, typed proposal, ordered economic commit, invalidation, snapshot/hash, and restore. Then cover every profession and mass contention. Timing a proposal kernel without its commit is not a completed slice.
4. **Complete a representative combat path end to end.** In-range unit attacks and chase, then forced/building targets, holding, drive-by, and special behavior. Account for each remaining adapter explicitly.
5. **Apply independent algorithmic fixes.** Local projectile structure queries and spatial serial-tail removal can proceed once their own phase/order oracles exist, without waiting for the optional larger navigation/laser rewrites.

For every slice, retain it only after correctness, useful-throughput, whole-tick cost, and memory gates. A failed optimization returns to its reference path rather than expanding into more architecture to justify itself. Performance-path selection must not enter replay/snapshot semantics. Intentional behavior revision remains a separate, explicit compatibility decision.

### 4.3 Performance budget

Continue targeting approximately:

| Subsystem | Mean budget |
|---|---:|
| Unit statuses, targeting, combat and hit commit | 8 ms |
| Turret decisions, projectiles and laser damage | 3 ms |
| Worker decisions, assignment and economy | 6 ms |
| Movement/navigation, including worker travel | 5 ms |
| Spatial indexing | 3 ms |
| Separation | 4 ms |
| Statistics | 3 ms |
| Visibility | 2 ms |
| Hashing/ordinary resync | 2 ms |
| Production and building maintenance not counted elsewhere | 1 ms |
| Remaining tick work | 3 ms |
| **Total** | **40 ms** |

These are non-overlapping targets, including preparation, barriers, compaction, and commit. They are not additive speedup predictions.

The 8+3 and 1+3 splits allocate explicit room for the newly detailed workstreams while retaining the original 40 ms total; they are provisional until measured. Charge shared work once: unit/worker travel to movement, shared indexes to spatial indexing, all profile work to statistics, and visibility/hash/publication to their respective scopes. Track logical per-population attribution separately rather than adding it again to phase totals. Include ordinary topology maintenance in its owning phase and report burst ticks/tails, not just amortized averages.

Frame publication has a separate integration budget and cannot grow an unbounded backlog.

Recompute the whole-tick bound after every stage. If a fraction f of baseline tick time remains unchanged, even infinitely fast replacement of everything else cannot exceed 1/f total speedup. A 20x target therefore requires unchanged work to occupy less than 5% of the baseline, with room for the optimized work itself. Worker dominance does not justify leaving combat, buildings, or maintenance unmeasured. Use measured remaining milliseconds to choose the next bottleneck rather than multiplying individual speedups.

### 4.4 Major pitfalls

| Risk | Required safeguard |
|---|---|
| “Pure” worker query advances research | Explicit activation intents and ordered commit |
| Dirty-only stats remove periodic health changes | Separate profile caching from scheduled mutations |
| New prefix-table system does more work on sparse maps | Deterministic direct/prefix/tiled work estimator |
| Destination caching helps only repeated routes | Fully active unique-destination tests and incremental topology repair |
| Incremental shortest paths retain invalid predecessors | Full-recompute oracle for increases, decreases, removals, and ties |
| Pair-once collision assumes symmetric correction | Compute each side independently, including rounding |
| Pair records explode in dense contact | Bounded per-job accumulations |
| Journals miss changes or lose deltas during coalescing | Mutation entrypoints, epochs, watermarks, reconstruction tests |
| Parallel kernels feed a large serial object commit | Typed commit streams and separately measured commit cost |
| Two-player resource processing becomes two huge serial queues | Parallel unconditional reductions; short ordered conditional folds |
| Healer policy prevents enough legal assignments | Preserve policy; construct sufficient legal work rather than reducing workload |
| Hash caches hide corruption | Scheduled authoritative reads and independent full hashes |
| Partial repair omits shared dependencies | Explicit reference/task/reservation closure |
| Snapshot encoding mixes ticks | Retained patch-tick data |
| Slot packing changes deterministic order | Separate canonical order from execution layout |
| Helper failure causes double status damage or spending | Mutation-safety classification and fenced recovery |
| More buffers consume the gains through memory traffic | Per-subsystem byte accounting and no full-state duplication |
| Faster ticks produce less work | Mandatory economic and combat throughput counters |
| Combat kernels cover easy states while expensive states retain object updates | Per-state fallback counts and timings, including forced/building targets |
| Sleeping on attack readiness ignores a target leaving range or sight | Independent engagement validation and relevant change dependencies |
| Parallel damage changes death cutoff, retaliation, or floating-point results | Ordered typed fold; prove independence before grouping targets |
| Turret batching changes category or equal-distance priority | Preserve each query's actual comparator and traversal tie rules |
| Projectile indexing changes first collision or expiry behavior | Canonical candidate priority and hit-before-expiry oracle |
| Stale projectile proposals miss a second candidate after the first dies | Ordered revalidation with complete candidate continuation |
| Laser relinking retains only nearest neighbors or delays observable changes | Full-link oracle and explicit publication boundaries |
| Laser strip queries miss large-radius units | Conservative per-cell/global radius bounds and index-motion margins |
| Cached producer fronts lose payment or ready-order changes | Queue generations, mutation hooks, and scheduler replay oracle |
| Unified building status pass changes application timing | Preserve tower and producer sub-phases |
| Worker near-tie choice is treated as a sortable comparator | Preserve its canonical ordered fold and lexical tie semantics |
| Aggregate helper completion count hides a lost claim | Per-job completion, fenced recovery, and coherent tick publication |
| Fewer calculations require more memory traffic than they save | Whole-phase timing and peak/retained-byte gates |
| Faster local navigation changes route availability | Preserve logical readiness across warm/cold caches and helper counts |

### 4.5 Compatibility

Add simulation and hash revisions to negotiation and snapshots. Reject incompatible peers before simulation.

Import version-7 saves into the new authoritative representation, preserving cargo, materials, task identity, reservations, cooldown eligibility, route readiness, and in-progress world state.

Old outcome-exact replays remain tied to their original engine revision. The new serial engine and helper engine must agree with each other.

## 5. Verification and final acceptance

### Correctness references

Use:

1. Legacy scalar references for unchanged formulas and pure algorithms.
2. A simple serial implementation of the new phase contract.
3. Independent rebuilds of maintained indexes and hashes.

Compare per-tick state with 0, 1, 3, and 7 helpers, varied scheduling and chunk sizes.

### Additional tests introduced by this refinement

- Direct, full-prefix, and tiled-prefix counts agree for randomized windows, clipping, empty groups, and sparse/dense distributions.
- Shared stat profiles retain periodic health flooring/clamping and bookkeeping.
- Parallel healer top-k equals the current ordered scalar selection.
- Research activation occurs once despite many simultaneous search requests.
- Incremental navigation equals full recomputation after wall/cost/exit changes.
- Unique-destination workloads do not thrash route storage.
- Pair-once separation equals directional scalar accumulation for unequal radii, moving/resting pairs, exact overlap, negative rounding ties, and mixed layers.
- Hostile summaries preserve current owner and structure rules.
- Frame deltas survive skipped publications, delayed reads, buffer reuse, and restore epochs.
- Regional patches avoid unrelated population scans while preserving dependency closure.
- Hash history remains immutable after later ticks reuse working buffers.
- Every ordinary-unit state in E4 agrees between the new serial and helper engines, including scouts, flying units, forced targets, held positions, building attacks, and mixed statuses.
- Fractional attack cooldowns, turret decrement-and-return cooldowns, empty turret searches, and restored deadlines reproduce eligibility exactly.
- Ram self-death, simultaneous lethal attacks, focus fire, status combinations, first retaliation, and target removal/replacement retain ordered outcomes.
- Spatial turret queries preserve preferred-target/category priority, area-border behavior, equal-distance traversal ties, and construction/ownership changes.
- Indexed projectile collisions equal the exhaustive reference for overlapping candidates, units before structures, collection order, aimed floor items, same-tick target destruction, and expiry at impact.
- Projectile compaction preserves reverse processing order, survivor order, fresh shots, and snapshot/hash state.
- Indexed laser connections equal full pair recomputation after placement, removal, walls, ownership, construction completion, and effective-level changes; include dense legal link graphs.
- Beam-strip queries equal existing hit results for large-radius units, endpoint boundaries, crossing/overlapping beams, resistance, and same-phase destruction.
- Incremental producer readiness equals the existing scheduler through payments, queue edits, disabled queues, population saturation/release, failed spawning, the 2,048 limit, and restore.
- Maintained building activity lists match independent exhaustive discovery after damage, repair, ownership, upgrade, and topology changes.
- Worker candidate selection preserves the ordered near-tie fold for randomized canonical streams, lexical numeric keys, existing-target bias, large stable IDs, and adversarial scores within 1e-9.
- Maintained conflicts preserve distinct query/setter behavior, different-owner occupancy, same-tile target replacement, returning claims, and mobile target crossings.
- Work availability queries cover all search origins/domains; mass wakeups enqueue once, cached builder eligibility respects its specified visibility tick, and epoch reset cannot hide work.
- Dense/sparse activity and spatial paths produce the same state and query order, including teleports, area borders, and order-buffer reuse.
- Helper fault injection proves no hangs, duplicate effects, partial tick publication, stale-generation writes, or premature command acknowledgment.
- Grow/shrink, slot reuse, capacity rebind, long-tick/deadline boundaries, generation wrap, and same-tick restore preserve identity and release obsolete storage.
- Navigation requests arriving during rebuild, cold-cache restore, and cache eviction preserve exact logical readiness and routing ties.

### Mandatory workload families

- The supplied mixed battle.
- Mixed battle with all workers legally employed.
- Each profession completing repeated full work cycles.
- Unique and shared destinations.
- Crowded depots/worksites and dense combat.
- Idle fractions from 0% through 100%.
- Mass transitions between idle, moving, and working.
- Frequent mine depletion, construction, destruction, and research completion.
- Sustained spawn/death.
- Long runs exposing memory growth and periodic rebuilds.
- Browser operation with frame consumption slower than simulation.
- Normal-unit-only movement, sustained melee/ranged combat, mixed flying/ground units, hold/forced-target armies, and structure sieges; vary idle/engaged/chasing proportions without changing rules.
- Many attackers concentrating on one target and many independent fights, to expose commit serialization separately from acquisition cost.
- Turret-heavy battles with preferred targets, status-heavy targets, empty acquisition, continuous projectile fire, and large static building populations.
- Realistic tower counts: 5–10k towers (mixed types, lasers included) alongside comparable barracks counts; towers engaging towers across opposing lines; armies sieging tower lines (benchmark modes `TOWERS=8000` and `TOWERS=8000 BATTLE=mix`).
- A few thousand traps (lava, water, ice, poison, sand, mines) with units crossing them (lower priority: one-tile reach).
- Long laser corridors, many unrelated towers, dense collinear links, crossing beams, and repeated wall/link changes.
- Many quiet/empty producers, many unpaid fronts, fully funded production, population-blocked queues, and mass capacity release.

Measure useful progress: delivered resources, work applied, healing, research, trips, attacks, deaths, route delays, and command latency.

Record worker jobs and combat jobs separately, plus actual shots, projectile advances/impacts, beam links and victim hits, paid queue progress, and units spawned. Record visited candidates/cells, cache hits/invalidations, fallback reasons, ready/due counts, output bytes, and index maintenance time in diagnostic runs. Do not reduce useful work, legal links, target quality, production limits, or acquisition frequency to make timings pass.

For each family record entity/state counts, map and owner counts, seed, revision, hardware/runtime, helper count, warmup, and measured tick window. Use p50/mean for the inherited 20x gate and report p95/p99/max, memory, GC, and helper imbalance as well. Restore the same initial state between comparisons; do not time simultaneous benchmark runs. Existing test files are coverage references, not evidence that this proposed implementation has passed them.

Worker priority does not exempt combat or buildings from acceptance. Retain the supplied whole-tick and independently measured active-worker 20x requirements. Establish combat-only and structure-heavy baselines before implementation, require unchanged useful throughput and no material whole-tick regression in them, and publish their measured gains separately. Do not claim an unmeasured 20x gain for every individual subsystem.

During future implementation validation, use matching instrumentation and tick windows. Separate diagnostics from low-overhead timing. Include GC, helper waits, preparation, commit, hashing, and maintenance in the complete tick.

Capture both fixed-input scenario timing and closed-loop sustained simulation. Fixed-input repeats isolate algorithm cost; closed-loop runs expose altered assignments, battle attrition, growth, and route churn. Report actual state populations over the timing window so faster attrition or depleted work cannot masquerade as a faster implementation. Use repeated comparable runs and publish the spread, not only the best sample. A correctness test that changes workload through its instrumentation cannot serve as the performance baseline.

The success claim remains **measured whole-tick improvement with full gameplay throughput**. The new optimizations make that target more plausible by reducing duplicated queries, repeated graph work, serial preparation, and publication scans; none is counted as achieved until its correctness and end-to-end contribution are demonstrated.

