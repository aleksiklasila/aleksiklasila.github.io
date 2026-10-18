# Responsive movement with arbitrary destinations and area-based crowds

## 1. Core decision: precompute routing, not destinations

**A new destination must normally require lookups, not a new pathfinding job.** This applies equally to ten shared destinations and two million different endpoints.

The earlier proposal’s per-destination coarse solutions become an optional optimization. They cannot be the foundation: storing a routing row for every destination would recreate the initialization and memory problems at a different resolution.

Instead, precompute a **hierarchical routing atlas** from map geometry. It answers:

> From this region, toward that region, which traversable connection should I take next?

Combine that with small local routing tables around obstacles. Together, these provide a complete approximate route to an arbitrary endpoint without allocating a path or waiting for diffusion.

Priorities:

1. Respond to new orders immediately.
2. Start in a sensible direction and eventually reach reachable destinations.
3. Maintain solid terrain and meaningful large-scale crowd occupancy.
4. Improve route length and smoothness opportunistically.

Extra map preparation is acceptable. Runtime cache misses must reduce quality, not suspend movement.

## 2. Practical navigation representation

### Adaptive map geometry

Use these initial constants:

| Structure | Initial choice | Purpose |
|---|---:|---|
| Detailed obstacle block | 8×8 tiles | Bound local routing work |
| Largest completely open region | 256×256 tiles | Make open terrain cheap |
| Children per routing domain | At most 32 | Keep routing tables small |
| Hierarchy depth limit | 8 | Bound a steering query |

Partition the map into large completely traversable rectangles/squares and small blocks around obstacles. Within an obstructed 8×8 block, identify separate connected components. Each component becomes a routing node; disconnected pockets must never be treated as one region.

Connections store an actual traversable boundary span and its endpoints. Wide boundaries remain spans, rather than funneling everyone through one midpoint.

Maintain a direct tile-to-region lookup. Units do not search a quadtree during ordinary movement.

### Small, destination-independent local tables

For each obstructed 8×8 walkability pattern, precompute the first move between every pair of its 64 tile positions.

- Encode eight directions, arrival, and unreachable in four bits.
- One complete pattern table occupies **2 KiB**.
- Deduplicate identical patterns across blocks and movement profiles.
- Completely open regions need no table: steer directly inside their validated bounds.
- Respect diagonal corner restrictions and existing movement-profile rules.

A unit entering its destination block can therefore navigate to its own exact destination immediately. Two thousand units with two thousand different local endpoints do not create two thousand flow fields.

Local tables initially optimize legal travel distance. Clearance steering supplies smoother movement away from walls; local optimality does not gate readiness.

### Hierarchical routing atlas

Construct spatially local, connected groups of routing nodes, then group those domains recursively. Each domain contains at most 32 children.

Precompute a small all-pairs table inside each domain:

- Next child toward the target child.
- The concrete connection to cross.
- Approximate travel cost.
- Reachability.

With 32 children, the next-child table has only 1,024 entries. Store connections and costs separately in typed arrays.

An arbitrary route query:

1. Identify the source and destination regions.
2. Find their shared routing domain using precomputed ancestor labels.
3. Read the next connection toward the destination’s child.
4. Descend toward that connection’s source endpoint.
5. Return a local target or boundary span.

The domain solution is complete. Lower levels explain how to reach its selected connections; no destination-specific search is required.

Use positive costs and deterministic tie-breaking. Keep selected crossings stable while approaching them. This prevents units from switching between equivalent exits every update.

**Bound pathological cases explicitly.** Connected grouping does not guarantee a shallow hierarchy for every conceivable graph. Where the eight-level limit cannot represent the remaining structure, use precomputed routing forests with parent edges and subtree intervals. Those provide a complete, loop-free route on the published topology. They are a safety fallback, not the normal route-quality strategy.

A synthetic check confirmed that forest routing reaches destinations but can produce substantial detours, which is why the hierarchical atlas is the primary design.

### Topology and movement profiles

Precompute the profiles needed by the configured match, sharing identical local patterns and geometry wherever possible. Preserve owner-specific building access, collectors, flyers, and portal rules.

Initial terrain and resource mines are prepared once. During play:

- Mine destruction updates the affected blocks, connections, and ancestor tables.
- Building changes invalidate affected regions.
- Live collision masks reject newly blocked movement immediately.
- Publish repaired routing tables as coherent generations.
- Keep unaffected regions and tables usable.
- Share repairs around a broken connection; never generate a repair search for every affected unit.

An old route may encounter a newly blocked connection before repair finishes. It must stop or take a validated local alternative, not cross the obstacle or falsely declare arrival.

## 3. Unit state, kernels, and refinement

### Keep unique destinations inexpensive

Each moving unit needs its existing destination plus compact navigation state:

- Destination tile and movement profile.
- Order generation.
- Cached next connection/local target.
- Geometry generation validating that cache.
- Current velocity and motion interval.

Repurpose existing movement columns where possible. Do not allocate a JavaScript intent object, route array, field, or pending-search record for every unique endpoint.

Shared command handles remain useful for army orders, but independent destinations live directly in unit columns. Bulk destination assignment uses packed arrays and WASM kernels.

Internal interfaces should separate queries from background work:

- `navNextConnection(profile, sourceRegion, targetRegion)` — bounded atlas lookup.
- `navLocalStep(profile, sourceTile, targetTile)` — direct-region or local-table lookup.
- `navTopologyCommit(...)` — publish coherent changed geometry.
- `navRefineStep(baseTick, workBudget)` — explicitly budgeted improvement work.

The first two functions must neither allocate nor enqueue mandatory work.

### Movement pipeline

For each due movement block:

1. **Refresh intent:** detect changed orders and discard old steering immediately.
2. **Resolve steering when needed:** query navigation on order changes, region crossings, invalidation, or steering expiry.
3. **Sample crowd fields:** combine desired direction, pressure, and permitted speed.
4. **Propose movement:** SIMD position integration over the elapsed interval.
5. **Validate exceptions and capacity:** handle obstacle crossings, crowd admission, portals, and gameplay events.
6. **Commit:** update positions, occupancy deltas, spatial membership, and presentation anchors.

Reuse steering while its geometry and travel horizon remain valid. Ordinary open-space movement should mostly execute:

`position += velocity × elapsedTime`

Navigation lookup and obstacle traversal must not be repeated for every intermediate base tick.

Terrain checks cover the swept segment, not only its endpoint. Clearance certificates provide the fast path; uncertain crossings use bounded traversal and retain unconsumed movement time correctly.

### Refinement without destination explosions

Refinement improves an already working route:

- Better connection choices and clearance.
- Shortcuts through frequently used region pairs.
- Improved local approach paths.
- Congestion-aware alternatives.
- Optional destination fields for genuinely popular shared targets.

Use bounded typed-array caches keyed primarily by geometry and region pairs. Do not create one queued job for every cache miss. Maintain a bounded candidate set with reuse counters; one-off unique destinations continue using the atlas.

Publish complete shortcut segments or coherent routing-table updates. Do not mix unrelated partial improvements that can form loops. Pin an adopted segment until it completes or becomes invalid.

Optional destination fields use a bounded pool. Exhaustion means atlas navigation continues. Superseded orders lose refinement priority immediately.

### Delta-tick and responsiveness contract

Build on the ongoing sealed `dk`/`simDk` work:

- Integrate each elapsed interval once.
- Split intervals at authoritative command changes.
- Do not multiply navigation searches or separation iterations by `dk`.
- Use the same deterministic timeline for readiness, invalidation, and publication.
- Publish timestamped, terrain-validated motion anchors for smooth presentation.

An infrequent expensive simulation update must not become the command-response schedule. Use the adaptive scheduler’s short control slices, targeting intent and steering service every two base ticks. If that facility is still missing, implementing it is a dependency of the response target.

Background jobs have fixed work limits and deterministic publication boundaries. Never wait for an unlimited batch of unrelated navigation requests.

## 4. Crowd separation with practical capacity enforcement

### Density and occupied area

Use one-tile occupancy cells, with larger aggregates for pressure spreading and congestion.

Each unit contributes an occupied-area weight derived from its collision footprint. Track movement layers and the ownership information needed for crowd settling and enemy interactions.

Maintain density through movement/spawn/death/teleport deltas. Accumulation uses sufficiently wide integer totals, deterministic reductions, and published immutable generations.

Compute pressure with fixed-neighbor stencils. Terrain masks prevent pressure and available-space calculations from leaking through walls.

Temporary individual overlap is acceptable. Occupancy still represents real area.

### Pressure cannot be the only constraint

Movement proposals also pass through cell-capacity admission:

1. Aggregate requested incoming footprint by destination cell.
2. Grant transfers against current free capacity.
3. Credit departures only after those departures have been admitted.
4. Run a bounded second admission pass using newly available capacity.
5. Leave unresolved transfers at their last legal boundary for the next update.

Use deterministic weighted prefix admission over stable unit order, with rotating priority to prevent permanent starvation. Do not admit based on which helper thread finishes first.

This deliberately favors conservative temporary slowing over uncontrolled compression. Full cyclic exchanges may wait until space becomes available; pressure should encourage spreading around the blockage.

Apply capacity checks to separation pushes as well as intentional movement.

For initially overfull cells:

- Permit outward transfers.
- Reject additional net inflow.
- Increase bounded spreading pressure.
- Drain excess progressively without teleporting units.

### Broad destination settling

A crowded rally becomes a gathering area across connected walkable cells. Once nearby cells fill, later arrivals slow and spread outward.

Workers and precise interactions still approach their required endpoint. Combat groups may settle across the occupied gathering area under existing arrival semantics.

A density-dependent effective separation footprint can strengthen spreading. Cosmetic size changes are unnecessary for enforcing capacity.

The production crowd path contains **no unrestricted pair enumeration**, including in dense or blocked cases. Its work is occupancy reduction, fixed-stencil field updates, admission, and per-unit integration.

## 5. Implementation sequence and qualification

### Delivery order

1. **Instrument current behavior:** distinguish command delay, steering initialization, field waits, separation, movement, and presentation.
2. **Build the routing atlas and local-pattern tables:** validate arbitrary endpoint queries independently of unit simulation.
3. **Introduce the allocation-free movement path:** retain existing external commands and gameplay semantics.
4. **Replace pair separation with density and admission.**
5. **Integrate control slices, delta ticks, presentation, and recovery.**
6. **Add optional refinements only after the unrefined system passes responsiveness tests.**

Keep the old navigation/separation available temporarily for differential checks. Version changed simulation state and kernel interfaces; rebuild both WASM variants. Snapshot/restore must preserve or deterministically reconstruct all routing, admission, and scheduling state affecting subsequent decisions.

### Destination scaling tests

Use the real production startup and command paths with 4M total units and 2M commanded units on 2048×2048 maps. Test:

- One shared destination.
- Ten concurrent group destinations.
- 100 and 10,000 destinations.
- One million distinct destinations.
- Every commanded unit having its own endpoint, where sufficient valid endpoints exist.
- Continual endpoint changes and subset retargeting during movement.

Report actual distinct endpoint counts. Add larger maps and 8M-unit cases after the primary case works.

The critical scaling check: **increasing destination diversity must not allocate proportionally many map-sized fields, searches, or pending jobs.** Required growth is compact unit endpoint state; optional caches remain bounded.

### Acceptance criteria

- New commands visibly affect unobstructed commanded units within **one second** in the local/low-latency benchmark. Report first, median, p95, p99, and maximum response.
- Congested units adopt the new intent within that interval; movement can legitimately wait for physical capacity.
- Cache misses, saturated refinement queues, and disabled refinement do not prevent navigation.
- Coarse-only routing reaches reachable destinations without loops. Test initial heading, excessive detours, and arrival time—not merely whether units move.
- Density remains capacity-bounded for admitted inflow; existing excess drains when reachable space exists. Huge groups cannot continually collapse into one tile.
- Walls, narrow passages, disconnected areas, portals, destroyed mines, and new buildings remain correct.
- Test delta strides 1, 2, 3, 4, 5, 8, 10, and 20, including mid-motion replacement and swept interactions.
- Verify identical results across helper counts, supported engines, delayed jobs, and snapshot/restore.
- Sustain movement and changing destinations for ten minutes with bounded queue age and cache growth.

Responsiveness is the release gate. Better path quality is useful only after units already react promptly and continue making progress.
