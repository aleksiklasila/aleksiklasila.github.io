# Exact, compact SIMD index for area-range queries

**Status (2026-11-02): implemented** in `wasm/src/arq.rs` (towers, units' in-range checks, the JS queries in `data_state.js`); see OPTIMIZATION_PROGRESS.md. Differences from the plan: blocks close when their frontier is exhausted (no filling from unrelated areas); the query scans its touched blocks per level instead of bucket queues; occupancy filtering is the callers' (the towers' broad phase uses the hostile summed-area tables).

## Summary

Use **blocks of 16 areas with precomputed internal distances**, connected by the original edges between blocks.

Expose a lazy iterator:

```text
areas_in_range(source, maxHops, filter)
    → matching areas in increasing shortest-hop distance
```

The filter can select occupied areas, enemy teams, and broad categories. The caller can continue scanning and apply its own targeting criteria.

This keeps memory linear in the graph size. It precomputes reusable pieces of shortest paths, rather than storing every source’s complete neighborhood. Queries perform a bounded search over those pieces; they are not constant-time table lookups.

## 1. Precomputed representation

Treat connections as a static, undirected, unweighted graph. Remove duplicate edges and self-loops.

**Partition and number areas:**

- Pack areas into blocks of 16, favoring connected, spatially nearby areas.
- Use deterministic frontier growth: prefer the unassigned neighbor with the most connections into the current block; break ties by spatial order, then original ID.
- When a frontier is exhausted, fill remaining slots from the next unassigned area. Disconnected portions are supported.
- Assign consecutive IDs within each block: `block = area >> 4`, `lane = area & 15`. Remap the tile-to-area lookup during construction.

**For each block, precompute a 16 × 16 distance matrix:**

```text
D[entry][destination] = shortest path confined to this block
```

Each distance occupies one byte:

- `0–15`: internal hop distance.
- `255`: disconnected or unused slot.

A complete matrix occupies **256 bytes**, equivalent to 16 bytes per area. Each row fits exactly into a 128-bit SIMD vector.

Deduplicate byte-identical matrices, using a template ID per block. This can substantially reduce memory on repetitive graphs, but the memory bound below assumes no deduplication benefit.

**Retain cross-block connections** in flat CSR arrays: one offset array and one array of destination IDs. Internal edges need not remain in the runtime representation.

Crucially, the matrices contain **block-confined distances**, not assumed global distances. A globally shorter path may leave a block and re-enter it.

## 2. Exact query algorithm and API

```text
areas_in_range(source, radius, filter, context) → cursor
next_batch(cursor, outputAreas, outputHops, capacity) → count

distance(source, destination, maxHops, context)
    → exact distance within maxHops, otherwise OUT_OF_RANGE
```

Support radii `0–64`, include the source at distance zero if it matches, and return each area once. Equal-distance ordering is deterministic.

### SIMD relaxation

When a path reaches lane `u` of block `C` at tentative distance `d`:

```text
candidate[16] = unsigned_saturating_add(splat(d), D[C][u])
best[C][16]  = unsigned_min(best[C][16], candidate[16])
```

This updates distances to all 16 areas using contiguous vector loads, arithmetic, and stores. WASM provides the required byte-vector saturated addition, minimum, comparison, and bitmask operations. [WebAssembly SIMD specification](https://github.com/WebAssembly/spec/blob/main/proposals/simd/SIMD.md)

Skip the operation when the arrival does not improve the entry area’s existing distance.

### Search and ordered output

Use **65 distance buckets**, rather than a binary heap:

1. Initialize the source block using its source row.
2. Schedule each touched block at its smallest unsettled relevant distance.
3. Pop the next block from the lowest nonempty distance bucket.
4. Finalize the areas at that distance.
5. Return matching areas; propagate across cross-block edges with an additional cost of one hop.
6. Reschedule remaining work and stop when the radius is exhausted or the caller stops consuming results.

Only boundary areas and potential output areas need settlement events. Empty internal areas are traversed implicitly through the distance matrix.

Use one intrusive queue entry per block, avoiding duplicate queue entries and allocation. Compute candidate masks once per touched block and query.

**Why this remains exact:** every original path decomposes into internal block segments and cross-block edges. Each internal segment is replaced by an exact, realizable internal shortest path. Processing these connections in increasing distance therefore preserves global shortest paths—including paths that leave and re-enter a block.

Pair queries use the same search, stopping when the destination is finalized. They must not return a block-local matrix value as the global distance without completing the necessary search.

### Filtering and occupancy

Maintain a consistent occupancy snapshot for each querying phase:

- A 16-bit occupied-area mask per block.
- A 32-bit team-presence mask and category-presence mask per area.
- Corresponding OR summaries per block.

Example:

```text
for area, hops in areas_in_range(
    source,
    attackRange,
    occupiedOnly = true,
    teams = enemyTeams,
    categories = relevantCategories
):
    examine eligible entities in area
    update targeting score
```

Team and category summaries are conservative: an area containing a friendly turret and an enemy worker may pass both broad filters. The entity-level predicate resolves that.

**Filtering affects output, never connectivity.** Empty or friendly areas can still lie on a shortest path.

Update dirty occupancy summaries between phases; freeze them while cursors are active. Movement does not rebuild the static distance index.

Keep iteration and entity filtering inside WASM, with batch output when crossing into JavaScript. Avoid a JS call or allocation per visited area.

## 3. Memory and cache layout

Let:

- `N` = areas.
- `B = ceil(N / 16)` = blocks.
- `U ≤ B` = unique matrix templates.
- `Eₓ` = undirected cross-block edges.
- `P` = concurrent query contexts.

The proposed runtime allocation is approximately:

```text
256U + 16B + 12N + 8Eₓ + 32PB bytes
```

This includes distance templates, cross-block adjacency, filter summaries, and query scratch space. Bucket heads and small output buffers add a minor fixed amount.

Each query context uses 32 bytes per block for its distance vector, generation stamp, settled/output masks, and queue links. Generation stamps avoid clearing the entire context on every query; wraparound requires an explicit safe reset.

For a simple planar graph, `Eₓ ≤ 3N − 6`. With four query contexts and no template sharing, the bound is approximately **61 bytes per area**.

| Area count | Conservative runtime bound |
|---|---:|
| About 667,000 | About **39 MiB** |
| 4,000,000 | About **233 MiB** |

These figures exclude entity storage, the tile-to-area map, and construction temporaries. A 2000 × 2000 lookup using 32-bit area IDs adds about **15.3 MiB**.

Share one immutable index and occupancy snapshot across workers; only query contexts are private. Use contiguous typed arrays, aligned matrix rows, and no per-area objects. Release construction adjacency and remapping temporaries before gameplay.

## 4. Performance limits and validation

The main advantages are predictable memory, compact working data, vectorized internal traversal, and lazy filtered output. No favorable source-cache hit rate is required.

However, **two million fully consumed range queries per tick is not a throughput guarantee**. Even a 10 ms allowance gives only 5 ns per query. The number of visited blocks and returned areas still matters; SIMD does not eliminate that work. Empty blocks can remain necessary transit blocks.

A scalar feasibility model passed **3,010 filtered queries across 43 graphs**, checked against ordinary BFS. It included disconnected regions, trees, a high-degree hub, radius boundaries, and a shorter path that leaves and re-enters a block. This validates the algorithmic model, not production bucket scheduling or WASM speed.

Before accepting the implementation:

- Compare complete results and distances against BFS, including radii `0`, `1`, `8`, `63`, and `64`; partial iterator consumption; mixed-team areas; and generation wraparound.
- Verify identical results across scalar/SIMD implementations and worker counts.
- Benchmark actual WASM serially against compact CSR BFS, emphasizing radius eight, cold source distributions, sparse/dense occupancy, early stopping, and complete enumeration.
- Retain raw timings, p95/p99/max, visited blocks, vector relaxations, cross-edge scans, results returned, worker throughput, and peak memory.
- Measure construction separately from gameplay queries.

The proposed default is therefore **16-area distance blocks, exact bucketed traversal, snapshot-based filtering, and a streaming API**—with throughput established by measurement rather than inferred from SIMD width.
