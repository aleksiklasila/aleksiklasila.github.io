# 400k units per team: a data-oriented, vectorized simulation rewrite

## 1. Performance target and priorities

Target **800,000 live units**, sustained at 20 TPS on this Ryzen 7 4800H/16 GB machine with one visible Edge client and a remote peer.

After warm-up, require three five-minute runs with:

- Mean complete tick **≤40 ms**, p99 **<50 ms**.
- **≥19.8 TPS in every rolling 10-second window**.
- Stable memory and bounded helper queues.
- No unexpected desyncs, recovery patches, or runtime errors.

Use **3× faster complete phases as the minimum design target for the major hotspots**, rather than expecting individual four-lane instructions to deliver 3× overall. The historical 147 ms larger run requires approximately **3.7× overall improvement** to reach 40 ms.

Prioritize eliminating repeated work and memory traffic, then vectorizing what remains.

| Priority | Major change | Historical cost | Initial target |
|---|---|---:|---:|
| P1 | Replace unit/object execution with shared state and batch kernels | 25.3 ms unit pass | ≤6 ms, including worker/structure work |
| P1 | Simplify movement and spatial maintenance | 23.5 ms movement phase | ≤8 ms |
| P1 | Replace separation’s scalar contact resolution and commits | 15.1 ms | ≤5 ms |
| P2 | Replace object hashing with canonical column hashing | 13.0 ms hash/resync phase | ≤3 ms |
| P2 | Share neighborhood queries and stat tables | 6.8 ms | ≤2 ms |
| P2 | Rework navigation, visibility, statuses, hits, and orders | Mixed and overlapping timings | Measure separately; target ≥3× for dominant paths |

These are targets, not achieved results. Existing timings overlap and come from an attriting population. Establish a fresh full-population baseline before attributing savings.

Create a new `TPS_400K_PER_TEAM_PLAN.md` containing the implementation stages, benchmark manifests, measured results, and rejected experiments.

## 2. Data structures designed for the hot operations

### Minimal authoritative unit state

Replace the current **172 columns / 552 bytes per slot** with a small core and optional components.

Use separate contiguous arrays, not an array of small structs:

```text
id[]
xQ[], yQ[]                  signed eighth-pixel coordinates
energy[]
archetypeRef[]              owner, type, base level/stack definition
effectiveStatsRef[]
orderRef[]
flags[]
extensionsRef[]
stateRevision[]
```

With 32-bit entries, this core is **40 bytes per unit**. Identical units share definitions, level-derived stats, orders, and route data.

Do not store per-unit copies of radius, maximum energy, speed, resistance flags, attack style, rendering properties, or derived stat objects.

Specialized SoA pools hold:

- Movement steps, residuals, steering expiry.
- Combat target and attack deadline.
- Worker task, cargo, reservation, and target.
- Active status effects.
- Explicit paths and cursors.
- Rare individual overrides.

Target **96–160 bytes of persistent authoritative state per live unit**, including optional components and their indexes. At 800,000 units, this would save approximately **300–350 MiB of live unit storage** relative to 552 bytes per unit, before accounting for capacity headroom and removed JS objects.

### Separate persistent state from execution views

Use three deliberate layouts:

1. **Entity columns:** compact authoritative state, suitable for movement and hashing.
2. **Spatial runs:** contiguous cell-ordered coordinates and metadata for separation, acquisition, visibility seeds, and neighborhood statistics.
3. **Grid/area planes:** contiguous masks, counts, costs, distances, and signatures.

Do not force every operation through one layout. However, every additional layout must justify its packing and maintenance cost.

Allocate in 4,096-slot pages, align column bases to 64 bytes, and maintain activity masks per 128-unit block. Optional pools remain dense; page compaction occurs at deterministic maintenance boundaries rather than every tick.

Use leased coordinate generations instead of separately copying position arrays for every consumer. Share a snapshot only when consumers require the same tick and phase.

### Compressed spatial coordinates

Keep authoritative global coordinates as `i32`. For cell-ordered spatial runs, benchmark **`u16` cell-local coordinates**, with a shared cell origin.

This permits:

- Eight coordinate values per 128-bit load.
- Smaller packed snapshots and fewer cache misses.
- Integer relative-coordinate subtraction before widening for geometry.

Only use this encoding where local-coordinate and relative-delta bounds are proven. Large-radius or distant-cell interactions use the wider representation.

### Buildings and shared records

Buildings store tile, identity, energy, stack quantity, shared-stat references, flags, and optional components. Derive world coordinates from the tile.

Store production queues, construction progress, research, adjacency membership, and tower combat in specialized pools. Share adjacency results by component and stats by definition/level.

Create one schema source for JS views, Rust bindings, serialization, hashing, defaults, and ABI tests. Every field must be classified as authoritative, derived, scratch, or presentation.

Preserve wide economy arithmetic: the fixture’s large resource balances must not be narrowed merely because positions and flags become compact.

## 3. Algorithms for the largest gains

Use standard deterministic Wasm SIMD: four 32-bit lanes, eight 16-bit lanes, or sixteen byte lanes per 128-bit vector. Bitsets can test 128 booleans at once. Avoid relaxed SIMD in authoritative calculations. [WebAssembly SIMD specification](https://github.com/WebAssembly/spec/blob/main/proposals/simd/SIMD.md)

### A. Movement: vector integration, shared steering, sparse exceptions

The movement motor should integrate committed steps, not repeatedly interpret orders, search routes, inspect object state, and repair paths.

**Numerical representation**

- Position: `i32`, 1/8 pixel.
- Velocity: fixed-point, 1/65,536 pixel per tick.
- Residual: retained fractional displacement.

For four units per axis:

```text
a       = velocity + residual
delta   = (a + 4096) >> 13
position += delta
residual = a - (delta << 13)
```

Define and test rounding for negative values. Validate intermediate bounds; use a wider Rust path for exceptional configurations.

**Vector fast path**

- Test moving/live/frozen masks by block.
- Skip inactive blocks.
- Integrate X/Y vectors.
- Compare against committed corridor/arrival bounds.
- Compute tile changes using shifts for power-of-two tile dimensions.
- Emit masks for arrival, changed cell, and expired steering.
- Compact only exceptional lanes into follow-up batches.

Benchmark one, two, and four independent vectors per loop. Avoid excessive unrolling that spills registers.

**Shared decisions**

Cache steering by route, movement profile, and spatial cell. Thousands of units following the same order should reuse flow samples and corridor information.

Helpers handle obstacle sweeps, steering refresh, path repair, and arrival decisions. Instructions contain an expiry and topology revision. Invalid instructions cannot move a unit through newly placed terrain.

**Expected source of improvement:** smaller hot state, fewer branches and indirect reads, fewer steering queries, and vector integration. SIMD alone is not the whole movement rewrite.

### B. Separation: full vector contact solving with exclusive outputs

The existing Rust path vectorizes rejection but resolves surviving contacts scalarly. Replace that with vectorized contact resolution.

**Default algorithm: directed Jacobi separation**

Read an immutable spatial snapshot. Each job owns output units and writes only their pushes.

A pair may be examined twice, but this removes neighbor-output races, row-color barriers, and shared floating-point accumulation. Compare complete pass time against the existing pair-once algorithm.

**Four-query × four-candidate tile**

For each tile:

1. Load query and candidate coordinate/radius vectors.
2. Rotate candidate lanes through four permutations.
3. Evaluate all sixteen pair combinations.
4. Apply self, layer, ownership, and distance masks.
5. Compute vector distance, penetration, and push direction.
6. Quantize contributions into bounded fixed-point accumulators.
7. Accumulate push, contact count, and deepest overlap.
8. Damp and clamp each query’s result.
9. Commit once per output unit.

Use a deterministic ID-pair direction for exact overlaps. Substitute safe distances in masked lanes to avoid invalid arithmetic.

Retain terrain collision checks when applying pushes.

**Reduce work before distance calculations**

- Reject whole cell pairs using bounding boxes and maximum radii.
- Skip settled cells and unchanged sparse neighborhoods.
- Split dense cells by estimated candidate work, not row bands.
- Reuse packed coordinate runs across compatible neighborhood kernels.

**Bound dense crowds**

Test candidate examination limits of 16, 32, and 64 per unit, using deterministic spatial quotas and rotating samples. Supplement sampled contacts with cell-density pressure.

Select the fastest setting passing the crowd-quality gates; prefer more candidates within measurement noise. Freeze the selection into the simulation rules.

The limit applies to candidates examined, so dense crowds cannot hide an unbounded scan behind a bounded contact count.

### C. Hashing: stream canonical words and vectorize independent entities

Replace object traversal, numeric type discovery, and string/property processing with schema-defined word streams.

- Hash four independent entities in SIMD lanes.
- Interleave two batches to shorten dependency-chain stalls.
- Hash X/Y directly as fixed-point integer words.
- Hash energy through its canonical stored representation.
- Hash shared definitions and orders once, then reference their canonical identities.
- Process optional component pools contiguously.
- Merge per-job regional results with deterministic integer operations.

Start from the existing integer word mixer, expressed in vector operations. Preserve authoritative field coverage and regional detection cadence.

Remove hot-loop conversions between Float32 storage and JavaScript-style numeric encodings. Normalize supported values at authoritative write/import boundaries.

Cache digests for immutable or explicitly versioned records. Do not cache moving-unit digests unless all relevant writes invalidate them correctly.

Include movement residuals, cooldown deadlines, reservations, and pending authoritative effects. Exclude presentation state and reconstructible execution scratch.

**Expected source of improvement:** much less state to hash, no object walk, no repeated shared data, contiguous loads, and four independent hashes per vector.

### D. Effective stats: one neighborhood answer for many units

The current large-unit kernel repeatedly sums rectangular windows. A summed-area-table implementation exists elsewhere, but the large path bypasses it.

Replace per-unit neighborhood traversal with:

1. Contiguous count planes indexed by owner/type.
2. Deduplicated queries keyed by plane and rectangle.
3. Rust summed-area tables for heavily reused windows.
4. Direct vector summation for small, sparsely queried regions.
5. One result broadcast to units sharing the query.
6. Shared stat-row selection instead of object-level stat application.

Build prefix sums using vector scans:

- Within four lanes, shift-and-add to produce local prefixes.
- Add the preceding vector’s carry.
- Add the previous row with contiguous vector loads.
- Answer each rectangle using four corner values.

Choose direct summation versus a prefix table using deterministic work estimates: total requested window area versus table-build area. Both paths produce identical integer counts.

Use precomputed level/hysteresis thresholds instead of repeated logarithms and powers. Update upkeep and population bins from reduced change records.

**Likely gain:** algorithmic reduction from repeated window scans to shared O(1) queries, followed by vector application. This is a stronger opportunity than simply translating the current loop into Rust.

### E. Navigation: vector grids, shared searches, fewer fields

Do not attempt to vectorize a pointer-heavy search unchanged.

**1. Vector terrain preprocessing**

`navStepCosts` performs separable wall dilation with costs 1–3. Port it to:

- Byte-wide OR/max operations over sixteen tiles.
- Packed wall bitsets for passability tests.
- Horizontal and vertical stencil passes with explicit boundary masks.

Apply the same approach to dirty masks, profile comparisons, and changed-topology detection.

**2. Bucketed local distance fields**

For 32×32 clusters and their larger local windows, implement weighted wavefronts using four rotating buckets for costs 1–3:

- Represent dense frontiers as bitsets.
- Expand north/south/east/west through shifts and masks.
- Split frontier contributions by the correct edge-cost class.
- Remove settled cells.
- Merge duplicate arrivals with bitwise OR.
- Record distances and deterministic direction ties.

Preserve the current reverse-search cost convention.

Use scalar Rust Dial queues for sparse frontiers. Switch to bitsets when frontier density crosses a fixed, benchmarked threshold. Both representations must produce identical fields.

Use `u16` local distances only when their maximum possible cost fits below the unreachable sentinel; otherwise use `u32`.

**3. Vector distance/direction extraction**

Where distances are already available, process eight tiles at once:

- Load neighboring distances.
- Add step costs.
- Compare candidates.
- Select direction using a fixed tie order.
- Write compact direction bytes.

This is regular work with substantially better SIMD suitability than heap operations.

**4. Share global routes more aggressively**

Retain exact local destination handling, but allow coarse routes to share a destination cluster/region and movement profile. This changes some route choices but preserves navigation intent.

Keep exact destination keys where seeded exit costs materially affect the result. Do not mistakenly assume all existing destination rows are identical within one component.

Remove JS seed construction, sorting, and copying around Rust searches. Maintain reusable scratch directly in Wasm.

Benchmark batching four destination searches over one topology with `distance[node][queryLane]`. Retain this only when shared traversal and lane occupancy beat four independent Rust searches.

**5. Incremental topology**

Rebuild dirty clusters and affected boundary connections. Reuse immutable topology pages. Avoid regenerating every cached field after a local wall change; invalidate fields through explicit topology dependencies.

Measure total navigation CPU, request-to-ready latency, cache memory, and main-thread waiting—not only `navTick`.

### F. Spatial counts and indexing: reduce atomic traffic

The current paths include per-unit atomic count changes and ordering work.

Replace hot updates with:

- SIMD tile/cell-key generation.
- Vector equality masks to identify unchanged cells.
- Compact `(cell, owner, type, delta)` records only for actual changes.
- Per-job accumulation.
- Radix grouping or segmented reduction.
- One write per affected count entry.

Use count/prefix/scatter construction for full rebuilds. Use incremental updates when relatively few memberships change. Select the mode from a fixed data-dependent threshold, not elapsed time.

Build owner masks, counts, bounding boxes, and maximum radius during the same compatible cell-run pass.

Profile actual dispatch first so compatibility-only code is not mistaken for a production hotspot.

### G. Visibility: reduce sources before spreading

Nearby units often submit the same area/range seed.

- Group sources by owner, covered area signature, range, and watching-team state.
- Reduce maximum range or maintain range histograms before writing shared seeds.
- Replace per-unit compare/exchange loops with per-job reductions.
- Maintain area visibility as packed bitsets.
- Compute newly visible/hidden areas through vector XOR/AND operations.
- Enumerate only changed bits for downstream updates.

For irregular area graphs, retain CSR traversal where it wins. Vectorize masks and grouped relaxations; do not build a dense area-by-area matrix merely to use SIMD.

In full-visibility matches, bypass unnecessary coverage computation while preserving any separate gameplay mechanic that genuinely requires it.

### H. Lasers, statuses, hits, and worker work

**Lasers:** the current unit kernel traverses a tile’s beam list repeatedly. Precompute damage and relevant beam metadata per tile/owner/immunity class. Apply the result to contiguous unit batches. Preserve beam-hit reporting and resistance semantics.

**Statuses:** replace countdown scans with expiry ticks and active-effect pools. Vectorize damage over time across affected units. Cosmetic flash timers move to presentation.

**Hits:** group by target and effect style. Process independent targets in vector lanes. Preserve canonical ordering for effects whose result depends on order; aggregate only commutative effects.

**Workers:** share candidate searches by owner/task/spatial cell. Score candidates with vector distance and eligibility checks. Resolve reservations and economic effects in deterministic batches.

**Adjacency:** compare tile signatures in wide vectors, extract horizontal runs, build tile-local components, then merge boundary and portal connections in canonical order. Handle deletions by rebuilding affected connectivity; ordinary union-find alone cannot remove a bridge.

**Lifecycle:** use wide live/dead tests, bitmasks, prefix sums, and dense component compaction. Remove unconditional scans and clears of obsolete movement-output columns.

## 4. Implementation order and execution rules

### Stage 0 — Measure the complete critical path

Rebaseline the existing 400,000-per-team fixture, with benchmarks run alone.

Reconcile exclusive timers with complete tick time. Investigate any material “other” category rather than assigning optimistic savings to it.

Record per subsystem:

- Wall time and total helper CPU.
- Bytes read, written, packed, and copied.
- Query count and unique-query count.
- Active entities/cells and candidate examinations.
- Job duration distribution, queue age, and barrier time.
- Allocations, memory peaks, and fallback calls.

### Stage 1 — Compact state and remove object execution

Implement the shared schema, unit/building cores, optional pools, shared stats/orders, and batched lifecycle.

Migrate worker/structure behavior and the remaining unit pass. Remove `_forEachUnitInTickOrder` from production execution.

Verify the existing research UI fix against read-only mirrors.

### Stage 2 — Movement, spatial runs, separation

Implement the vector movement motor and shared steering, then cell-run construction and full vector separation.

Measure their combined cost, including spatial packing and synchronization.

### Stage 3 — Shared queries, navigation, and hashing

Implement shared neighborhood statistics, navigation preprocessing/local fields, route reuse, and canonical vector hashing.

Prioritize these by the refreshed profile; the larger historical navigation allocation makes memory attribution an early requirement.

### Stage 4 — Remaining regular passes and presentation

Convert visibility seeds/masks, lasers, statuses, hit application, adjacency, and worker candidate batches.

Move visual-only work to presentation and remove obsolete columns and JS kernel twins.

### Deterministic scheduling contract

Jobs declare input tick, commit tick, match epoch, input revisions, entity revisions, and owned output ranges.

- Inputs remain immutable until readers finish.
- Outputs have exclusive owners.
- Late required work is awaited at its fixed commit boundary.
- Effects merge in canonical order.
- Spawn identities are assigned after canonical ordering.
- Gameplay records are never silently dropped on buffer overflow.
- Resync and patch invalidate old jobs at the same agreed tick.
- Cache eviction, compaction, and approximation choices cannot depend on local timing.

Use new rules/snapshot versions. Preserve lobby presets; reject incompatible old running-match saves and peers. No old-save importer is required.

## 5. Benchmark gates and completion

### Controlled optimization experiments

For every substantial kernel rewrite, compare:

1. Current implementation.
2. New algorithm in scalar Rust.
3. New algorithm with SIMD.
4. Complete scheduled pass, including preparation and commit.

This separates algorithmic gains from SIMD gains and exposes packing or barrier regressions.

Benchmark helper counts 3, 5, and 7 with rendering active. Test unroll factors and job sizes independently before combining winners.

Measure a simple same-sized streaming kernel to estimate practical memory throughput. When a pass approaches that limit, prioritize fewer passes and smaller representations rather than more arithmetic tuning.

### Full-scale workloads

All performance optimization runs use 400,000 units per team:

- Dispersed movement with repeated large orders.
- Concentrated opposing fronts.
- Combat plus active economy, construction, research, salvage, and production.

Maintain full population at measured tick boundaries through deterministic replacements, including their costs. Preserve unit/type mix and report active movement/combat fractions. Run natural-attrition battles separately.

Test full visibility as the primary historical workload, plus team visibility/history so gains do not depend on bypassing those modes.

### Correctness and gameplay

- Scalar/vector agreement under the new arithmetic.
- Vector tails, masks, overflow limits, zero-distance contacts, and saturated crowds.
- Equal results across helper counts and deliberately altered job completion order.
- Late join, partial patch, full resync, stale references, and slot reuse.
- No wall penetration, resource duplication, lost orders, or persistent worker starvation.
- Existing crowd thresholds: mean penetration below 0.25 and reversal rate below 1.5% in the applicable scenarios.
- At least 90% of reference bottleneck throughput.
- Equivalent simulation hashes with rendering disabled or a different camera view.

### Final budgets

| Exclusive complete work | Mean budget |
|---|---:|
| Movement and spatial maintenance | 8 ms |
| Separation | 5 ms |
| Workers, structures, adjacency | 6 ms |
| Effective stats | 2 ms |
| Hashing | 3 ms |
| Navigation and orders | 4 ms |
| Hits, statuses, visibility | 5 ms |
| Coordination and publication | 3 ms |
| Headroom | 4 ms |
| **Total** | **40 ms** |

Target shared Wasm memory below 3 GiB and local game-browser memory below 8 GiB, with stable usage during a 30-minute churn/recovery soak.

Continue profiling and restructuring the largest remaining cost until the complete acceptance gate passes. A 3× microbenchmark, more SIMD instructions, or work merely moved to a busy helper queue does not establish success.