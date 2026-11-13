10× background optimization with SIMD throughout the pipeline

## 1. Target and measurement

Target **at least 10× less aggregate background work on active workloads**, including background chunks executed by the simulation thread. At the reported workload, approximately 550 ms becomes approximately 55 ms per step. This is an engineering target, not a measured prediction.

Measure the complete producer → computation → publication → foreground-consumption pipeline. Packing, indexing, invalidation, and commit costs count wherever they execute. Improving flow alone by 10× would improve the reported background total by only about **1.21×**, so the plan must cover the other lanes.

Before implementation:

- Capture a fresh baseline with aligned simulation-thread/helper profiles and per-tick phase traces. Distinguish accumulated chunk elapsed time from sampled CPU time.
- Fix flow diagnostics to count newly posted requests once, using batch IDs.
- Record actual live population and activity. The inspected older “1M” capture declined from approximately 427k to 312k live units; it cannot establish performance with one million active units.
- Run the existing mixed chaos workload first, then a sustained activity fixture. Freeze its setup and command stream before comparing implementations; require at least 900k live units throughout its measured window, continuing movement, combat, and successful worker transfers. Include all production and maintenance inside timing.
- Follow the [existing spike-analysis procedure](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/tests/CHAOS_SPIKES_BENCHMARK.md): previous, slow, next, and comparable normal ticks across all threads. Run timing comparisons serially after the current suite finishes.

## 2. Common SIMD pipeline and memory layout

Use this structure for every refactored family:

```text
Native state changes / snapshots
        ↓
Native partitioning and shared-query grouping
        ↓
Cache-local SIMD computation
        ↓
Native repacking into destination-slot panels
        ↓
SIMD validation and application
        ↓
O(1) batch publication by the simulation coordinator
```

**Internal batch interface**

Each batch carries its snapshot epoch, slot-layout generation, deterministic publication tick, panel offsets, counts, and validity masks. Payloads use subsystem-specific SoA columns.

- Use 128-slot destination panels with aligned columns and one writer per panel.
- Group computation by shared inputs—area, destination, navigation profile, owner, or stat row—then publish in destination-slot order.
- Carry stable unit IDs alongside captured slots. Maintain native relocation mappings across outstanding epochs; resolve moved units in the publication stage.
- Replace foreground per-result binary searches and scattered record reconstruction with contiguous vector validation and stores.
- Run bulk validation/application through foreground helper kernels. The coordinator dispatches and publishes; it does not loop through units.
- Any unavoidable permutation or irregular access remains inside WASM, happens once per batch, and appears explicitly in the measurements.

Use native parallel prefix scans for compaction, partitioning, and output offsets. Avoid a single serial prefix over population-sized arrays or helper-count × whole-map histograms. [Blelloch’s scan algorithms](https://www.cs.cmu.edu/afs/cs.cmu.edu/project/scandal/public/papers/CMU-CS-90-190.html) provide the underlying construction.

**Vector widths and precision**

The current browser target exposes **128-bit SIMD**. Use multiple independent vectors to increase throughput; do not assume that writing 256-bit operations yields native 256-bit WASM execution. [Official SIMD documentation](https://emscripten.org/docs/porting/simd.html)

| Data | Representation |
|---|---|
| Block-confined area distances | `u8`, 16 lanes |
| Visibility strength and compact predicates | `u8`, 16 lanes |
| Local navigation distances | Retain `u16`, 8 lanes |
| Unit IDs, slots, global area IDs, generations, route costs | `u32`, 4 lanes |
| Existing suitable position/scoring calculations | `f32`, 4 lanes |
| Economy/energy accumulations requiring existing precision | Retain their precision |

Widen before additions or products that can overflow. A 32×32 local navigation field with costs 1–3 fits in `u16`; that does not justify narrowing global routes or million-unit IDs. Existing positions use eighth-pixel integers, so global squared-distance arithmetic needs explicit bounds.

Use strict SIMD and fixed reduction order. Relaxed SIMD permits hardware-dependent results and is unsuitable as the default for peer-deterministic simulation. [WebAssembly’s specification](https://github.com/WebAssembly/relaxed-simd/blob/main/proposals/relaxed-simd/Overview.md)

**Cache and ownership rules**

- Separate frequently written counters from immutable descriptors. Replace the current 32-byte neighboring lane records with independently aligned control records.
- Align writer ownership and private scratch to 128-byte boundaries; pad small masks and counters so neighboring jobs cannot share writable lines.
- Keep reductions job-local, then combine in deterministic stages. Batch shared queue claims.
- Retain complete native stat tables; prepare effective hot columns on research/boost changes and broadcast shared values within grouped jobs.
- Budget tables, snapshots, relocation maps, and helper scratch against the existing production heap limits. Replace old arenas as conversions land; do not reduce supported population to fund duplication.
- Build derived tables entirely in the WASM heap. Preserve the build’s prohibition on data segments.

## 3. Algorithms to implement

### A. Make the existing area-query engine the shared foundation

The implementation in [arq.rs](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/wasm/src/arq.rs:1) is the right starting point:

- Sixteen areas form a block.
- A 256-byte matrix stores exact distances **inside that block**.
- One byte-vector saturated addition and minimum relax all sixteen destinations.
- Cross-block edges preserve paths that leave a block and re-enter it.
- Results currently emerge in increasing hop distance.

Its remaining costs are the repeated scan of every touched block at every distance, the extra pending scan, and unpacking settled masks one area at a time.

Implement:

1. **Distance-bucket scheduling.** Keep one intrusive queue entry per block, scheduled at its smallest unsettled distance. Move it when relaxation improves that distance; reschedule after processing. Eliminate repeated scans of inactive touched blocks.
2. **Block output.** Add a native `visit_blocks` interface supplying internal block ID, settled-lane mask, and distance vector. Keep `within` as the early-exit membership interface.
3. **Vector consumers.** Store occupancy, owner/category summaries, visibility, and candidate offsets in internal block order. Consumers filter blocks and lanes before enumerating entities.
4. **Private query contexts.** Use generation stamps, settled masks, and padded contexts. Reset safely on generation wraparound.
5. **Explicit ordering.** Guarantee increasing exact distance and deterministic FIFO ordering within buckets. Consumers needing a winner compare explicit distance/entity-ID keys instead of relying on incidental visitation order.
6. **Explicit range contracts.** Use byte distances only within the proven supported range. Wider legal queries use native wider distances; never silently truncate a query to 250 hops.

Reuse it as follows:

| Use case | Application |
|---|---|
| Worker reachability | Replace the separate scalar CSR BFS |
| Combat/tower range checks | Improve existing consumers; group identical source-window queries |
| Acquisition nearest-area answers | Reuse block relaxation in a persistent, labelled multi-source field |
| Visibility propagation | Reuse block distances with maximum remaining-strength propagation |
| Weighted navigation | Reuse the blocked/bucketed approach with navigation-specific costs |
| Manhattan nearest-spawner lookup | Keep a geometric distance transform |
| Occupancy and traffic pressure | Use their spatial/stencil algorithms |

For visibility, encode remaining strength as `strength + 1`, reserving zero for uncovered. Saturating subtraction against the block-distance matrix then produces sixteen coverage candidates. Source labels remain 32-bit and require separate vector comparisons.

### B. Flow looks and navigation

**Flow 152 and its preparation/commit stages**

- Group identical complete look keys before computation. Include navigation profile, destination, field/build generation, and wall dependencies.
- Share intermediate route work by source/destination parts. When caching intermediate steps, include the carried exit-hint state; `(tile, destination)` alone is insufficient.
- Change exit selection from **one tile gathering portal values** to **a contiguous tile panel evaluated against shared portal costs**. Load eight adjacent `u16` distances, widen, add broadcast route costs, and retain per-tile winners in registers across portals. The existing portal-major fields support this loop order.
- Separate common open-route packets from detour/error packets in native code, avoiding divergent branches inside the common vector loop.
- Replace quarter-tile floating-point sampling for tile-centre look segments with integer grid traversal, including explicit corner-touch checks. This adapts the grid-boundary traversal approach of [Amanatides and Woo](https://physique.cmaisonneuve.qc.ca/svezina/projet/ray_tracer/download/A_Fast_Voxel_Traversal_Algorythm_For_Ray_Tracing.pdf).
- Validate changed-wall exceptions in a native batch, then publish slot-ordered SoA answers for vector commit.

**Navigation build 135**

The local solver already uses Dial’s four buckets. Replace its scalar tile queues with **bitset frontiers**:

- Maintain four distance buckets, settled bits, and cost-class masks.
- Expand cardinal neighbors through shifts, row shuffles, and wall masks.
- Use active-block summaries to avoid scanning the entire cluster for a small frontier.
- Write local distances and derive directions in vector batches.
- Parallelize independent cluster/portal jobs without introducing a global barrier for every distance.

This specializes bucketed shortest paths to the existing 1–3 costs. General Δ-stepping is useful background, but its broader buckets can introduce additional work; the bounded-cost specialization is the first implementation. [Meyer and Sanders](https://ae.iti.kit.edu/sanders/papers/wmain.pdf)

Extend existing unchanged-cluster reuse into immutable cluster pages with stable handles. Rebuild changed clusters, affected cost halos/borders, and dependent routing ancestors. Invalidation must account for alternative exits and connectivity changes, not just walls along the previously selected path. Move the remaining per-node preparation loops into WASM.

### C. Acquisition and combat

Acquisition already samples a bounded number of candidates. The major opportunities are shared preparation, repeated field construction, and per-unit consumption.

- Maintain native area/owner membership from movement, ownership, birth, and death changes; update positions separately.
- Maintain nearest visible enemy-area and structure-class fields across snapshots.
- Apply source additions by labelled relaxation. On source removal, invalidate the affected winning-label region and repair it from surviving sources and valid boundaries.
- Provide a complete native rebuild for dense changes, selected by deterministic work counts. Both methods finish the required work before publication.
- Use the shared 16-area representation for relaxation and answer consumption. Compare labels explicitly for deterministic ties.
- Fuse combat eligibility and acquisition preparation: valid retained unit targets suppress unnecessary acquisition; retained structure targets must still allow the existing unit-target precedence.
- Preserve moving-shooter behavior, sampling semantics, and publication cadence.

Publish target kind, target ID/slot, validity, and range decisions as contiguous columns consumed by combat and movement.

### D. Workers

- Replace `ws_areas_within` with the shared block engine.
- Group identical source-window/radius queries across the batch, replacing the current last-query-only reuse.
- Share geometric eligibility results while retaining worker-specific reservations, jitter, current-target preference, and scoring.
- Maintain site membership and eligibility from native change journals. Avoid rebuilding every collector group on an unrelated structure change.
- Vectorize scoring over compact eligible site columns. Prune only with valid score bounds; preserve the existing result-count semantics.

Replace return-spawner scans over every eligible spawner with maintained exact **Manhattan nearest-label fields**, shared with other consumers only when eligibility predicates match.

Extend the existing incremental nearfield implementation. Vectorize full rebuilds using separable row/column scans and blocked transposes; keep deterministic lower-tile tie-breaking. This follows the L1 distance-transform construction described by [Felzenszwalb and Huttenlocher](https://www.cs.cornell.edu/dph/papers/dt.pdf). It does not substitute Manhattan distance for obstacle-aware area distance.

### E. Visibility and remaining lanes

**Visibility**

- Generate source changes only when the unit’s area window, strength, viewer membership, or life state changes.
- Coalesce contributions by area/viewer before writing shared state, replacing per-unit contended atomic maxima.
- Maintain maximum strength and its support count. When the last maximum contributor disappears, recompute that dirty area from its native membership.
- Propagate changed maxima through the block engine, handling both increases and decreases.
- Publish contiguous coverage blocks and changed masks.

This still helps moving armies: many unit changes leave an area’s maximum visibility contribution unchanged.

**Traffic, indexing, and retirement**

- Temporally tile the existing fixed-iteration traffic stencil with the necessary halo; preserve its iteration count and smoothing behavior.
- Vectorize output conversion and masks as well as the existing solver interior.
- Apply the common partition/prefix/publication design to index stages.
- Reduce retirement clearing only where initialization and validity contracts prove it safe. Count replacement birth initialization in the same performance budget.

## 4. Implementation sequence and further directions

Deliver complete vertical slices, each including native preparation, background computation, publication, and consumers:

1. **Instrumentation and batch infrastructure:** correct work counters, ownership layout, native partitioning, slot-ordered publication.
2. **Area engine and worker reach:** bucket scheduling, block-output API, meaningful correctness tests, first production consumer.
3. **Flow/navigation:** tile-panel exit selection, grouped exact looks, integer segment checks, vector commit, bitset local fields.
4. **Acquisition/combat and visibility:** persistent source sets, incremental labelled fields, block consumers.
5. **Nearest-worker fields and remaining lanes:** close the aggregate gap to 10×.

Investigate these additional directions after measuring the primary implementation:

- **Flow jump summaries:** compose bounded route runs of 1/2/4/8/16/32 steps, keyed by complete route/hint state.
- **Precomputed segment masks:** native-generated wall-test templates for bounded tile-centre offsets.
- **Alternative area partitions:** improve useful lane occupancy and reduce cross-block edges while retaining sixteen-area blocks.
- **Dense-frontier traversal:** evaluate push/pull switching only if measured frontier density supports it. Published direction-optimizing BFS benefits primarily concern low-diameter graphs, so its gains cannot be assumed for this map graph. [Beamer et al.](https://www.scottbeamer.net/pubs/beamer-sc2012.pdf)

Promote an experimental representation only if it preserves correctness, fits the production memory budget, reduces the **whole affected pipeline** by at least 15% in repeated comparisons, and does not regress gameplay tails.

## 5. Validation and completion criteria

**Correctness**

- Compare area results against ordinary BFS: disconnected blocks, multiple sources, paths leaving/re-entering a block, equal-distance ties, early exit, radius boundaries, and generation wraparound.
- Compare weighted local fields against Dijkstra; test navigation edits that alter connectivity or alternative exits.
- Test source removal, owner changes, vision changes, disappearing targets, spawner eligibility changes, and simultaneous additions/deletions.
- Exercise slot relocation, death/reuse, delayed helpers, stale batches, and snapshot restoration.
- Require identical retained-implementation outcomes across 0/1/4/8 helpers and different completion orders. Historical bit identity remains diagnostic.
- Validate both WASM build variants explicitly.

**Performance**

- Inspect emitted vector code and measure useful lane occupancy, scalar gathers, bytes moved, unique/shared queries, visited blocks, cross-edge work, invalidation size, packing cost, and commit cost.
- Retain raw ticks, actual population, successful work per base tick, p95/p99/max, slow-tick counts, and background spills onto the simulation thread.
- Use separate profiling and unprofiled timing runs, repeated in alternating baseline/optimized order.
- Require ≥10× aggregate background improvement on the qualified active workload, with preparation/publication costs accounted for and no offsetting foreground regression.
- Require reduced gameplay tail latency and slow-tick counts. A lower average alone does not complete the task.

Keep all production simulation processing in WASM, with no per-item JS preparation or fallback paths and no new per-tick work caps. Record each slice’s measurements and remaining bottlenecks in [OPTIMIZATION_PROGRESS.md](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/OPTIMIZATION_PROGRESS.md).