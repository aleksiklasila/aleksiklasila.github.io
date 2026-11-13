# Occupancy optimization: vectorize crossings, legal positions and candidate selection

## 1. Revised direction

The next revision should remove more work, rather than primarily widening the existing scalar resolver.

Three changes supersede the previous plan:

- **Replace the common short-movement loop with simultaneous boundary-crossing tests.** SIMD lanes represent positions along a path, so even one ordered mover gets useful vector execution.
- **Compute 64 legal center positions together using packed bitmap operations.** Reuse that result across the mover’s preferred path, slides and shoulders.
- **Use 16×8-cell bitmap words stored as `v128`, and 32-byte occupancy records.** This provides eight 16-bit bitmap rows directly and halves the previously proposed record size.

The repository’s [earlier experiments](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/OPTIMIZATION_PROGRESS.md:7794) show why this distinction matters: caching bitmap windows alone gave no meaningful benefit, and the scalar cell walker retained substantial arithmetic cost and hurt counterflow. The new fast path changes the computation performed on the window.

Target **at least 4× lower complete occupancy cost**, then continue retaining measurable improvements. All performance acceptance remains **current stable Edge, WASM32, default browser settings**. No experimental SIMD features, native-only acceleration or Node timing claims.

The intended widths are:

| Operation | Useful parallelism |
|---|---|
| Movement preparation and scoring | Four `f32` lanes; eight movers through two vectors |
| Small-footprint morphology | Eight `u16` rows, with many cells represented by bits |
| Legal-position construction | 64 centers together |
| Short-path geometry | Eight boundary events, using bounded local integers |
| Register-resident collision lookup | Eight or sixteen byte lanes |
| Swap filtering and ranking | Four candidates per iteration, with vector-maintained winners |
| Bitmap updates | 128 cells per word |
| Publication | Four contiguous slots per arithmetic/store group |

A loop that extracts four lanes and calls the scalar resolver four times does not satisfy this design.

## 2. Replace the common traversal algorithm

### Store bitmap rows in their SIMD-ready representation

Use a 16×8-cell word:

```text
v128:
    row 0: 16 occupancy bits
    row 1: 16 occupancy bits
    ...
    row 7: 16 occupancy bits
```

Arrange these words inside the existing 128×128-cell movement blocks. Storage remains 2 KiB per block per plane.

This layout allows horizontal dilation through `i16x8` shifts and vertical dilation through fixed shuffles. It avoids repeatedly unpacking eight separate row bytes from an 8×8 `u64` tile.

For the current raster, radii 1, 2 and 3 are exactly 1×1, 3×3 and 5×5 squares. Specialize those three shapes. All other radii retain a complete WASM SIMD implementation.

Build lookup tables in the WASM heap at match initialization. The full footprint-table sizing calculation for this layout is approximately **1.39 MB**, including padded masks, offsets and headers. Common square footprints can use smaller procedural masks and row-mask tables.

Do not introduce Rust static arrays that create data segments: the [current build rejects those](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/wasm/build.cjs:153), because helper instances share memory.

### Construct a legal-center field once per mover

For a common-radius mover, construct an 8×8 field describing which nearby center cells can accept its footprint.

The field covers center offsets `−3 … +4` on each axis. For radius 3, its input is a 12×12 occupancy patch; smaller radii require less input. At most six 16×8 words cover the largest patch, depending on alignment.

Perform these operations:

1. Assemble the patch into packed rows.
2. Remove the querying unit’s footprint **from the registers only**.
3. Expand occupied bits horizontally by the footprint half-width.
4. Combine neighboring expanded rows vertically.
5. Extract eight legal-center bits from each of eight rows.

For radius 3:

```text
horizontal[y] =
    row[y]
    | row[y] << 1 | row[y] >> 1
    | row[y] << 2 | row[y] >> 2

blockedCenters[y] =
    horizontal[y-2] | horizontal[y-1] | horizontal[y]
    | horizontal[y+1] | horizontal[y+2]
```

The result is eight bytes: **64 exact footprint-fit answers** for the square raster.

Own-footprint exclusion becomes a constant mask for each specialized radius. There is no temporary global clearing, restoration or per-query self-exclusion calculation.

Keep a separate compact wall-validity field using the unit’s navigation profile. This allows distinguishing occupancy blockage from wall blockage and preserving the unsteered fallback policy. Exact corner crossings also test the two side-wall positions.

This uses morphology to answer many placement questions together. The research supports exploiting that algebra when vectorizing neighborhood operations; this specific game layout and dispatch policy still require Edge measurements. [Cree, *Vectorised SIMD Implementations of Morphology Algorithms*](https://researchcommons.waikato.ac.nz/entities/publication/6d694a0f-ec38-4e9e-9791-1c7754bd86ab)

### Test boundary crossings simultaneously

For movements with length at most three occupancy cells, enumerate the possible X and Y grid-boundary crossings directly.

There are at most three crossings per axis. Use an eight-event packet containing four X-event lanes and four Y-event lanes, masking unused events.

For an X crossing:

```text
n = distance to that X boundary
d = abs(dx)

orthogonalNumerator = originFractionY * d + dy * n
crossedY = floor(orthogonalNumerator / (d * cellSize))
```

Compute all four X crossings together and all four Y crossings together. This eliminates the dependency chain of advancing one cell, testing it, and deciding the next step.

For the current 32-Q-unit cell size and three-cell range, the local numerator calculations fit signed 16-bit integers, including the padded event lanes. Use `i16x8` where these bounds hold; widen the two halves for four-lane floating-point quotient estimates.

Correct every estimated quotient with an integer remainder:

```text
remainder = numerator - quotient * denominator

if remainder < 0:             quotient -= 1
if remainder >= denominator:  quotient += 1
```

Apply those corrections with SIMD masks. Handle negative directions, exact boundaries, zero axes and endpoint inclusion explicitly.

This is exact cell classification within the stated bounds; it does not quantize headings or approximate the footprint.

Convert the resulting center coordinates into byte indices. Use `i8x16.swizzle` to select legal-row bytes, and another small register table to select the relevant bit. Eight or sixteen crossing positions can then be checked without bitmap loads inside a stepping loop.

Standard WASM shifts take a common shift count, so do not assume per-lane variable shifts exist. Register lookups address that restriction. Use fixed shuffles where possible; dynamic swizzles have additional lowering costs on some targets. [WebAssembly SIMD specification](https://github.com/WebAssembly/spec/blob/main/proposals/simd/SIMD.md), [Emscripten SIMD guidance](https://emscripten.org/docs/porting/simd.html)

### Select the first obstruction without a scalar scan

Store each ray’s blocked X crossings and Y crossings as ordered bit masks.

Use a 16-entry register lookup for the first set bit in a nibble. For eight-bit masks, combine the low- and high-nibble answers.

This yields the earliest blocked X and Y events for four rays together. Compare their times through integer cross-products:

```text
X occurs first if nX * abs(dy) <= nY * abs(dx)
```

Then compute and quantize the final position once. Preserve partial movement inside the last accepted cell; blocked movers must still close up and make gradual sideways progress.

This avoids replacing the old cell loop with another scalar loop over candidate events.

### Dispatch by geometry

Use these production specializations:

| Case | Kernel |
|---|---|
| Movement stays inside the same occupancy cell | Four-mover arithmetic path; no occupancy bitmap update |
| Radius 1–3, length ≤3 cells | 64-center field and eight-event boundary packets |
| Radius 1–3, length ≤7 cells | 256-center field and sixteen-event packets |
| Larger radius or longer movement | Four-lane incremental traversal with full footprint support |

The 256-center variant uses a 16×16 legal-center field. Its intermediate rows need 32-bit arithmetic because the radius halo exceeds 16 bits. Use bounded `i32x4` geometry and pack the finished field into two vectors. It covers longer steps without requiring a sequential cell walk.

Benchmark both field sizes before broad integration. They are geometry specializations, not reduced movement budgets; all valid longer movements remain fully processed.

For the general traversal, retain vector boundary increments and comparisons, with no division or square root inside the cell loop. Dispatch radius specialization outside that loop.

Evaluate the preferred movement first. Construct and score additional candidates only when the existing blocked-progress conditions require them. Reuse the same legal-center field for those candidates.

## 3. Remove scalar work surrounding collision checks

### Use compact records and temporary SIMD packets

Use a 32-byte occupancy record:

| Words | Contents |
|---|---|
| 0–3 | Current position, footprint metadata, first-stage movement flags |
| 4–5 | Requested position |
| 6 | Packed owner, swap eligibility and result flags |
| 7 | Revision counter |

Gather heading, movement allowance, tick-start position and route information once into a temporary eight-mover SoA packet. Do not persistently duplicate all those fields in every occupancy record.

Populate requested positions and eligibility during the existing first-stage WASM traversal. There is no separate JavaScript preparation pass.

Prepare arithmetic for eight movers using two four-lane groups, but consume them in deterministic order. If a preceding swap changes a queued mover, its revision invalidates the prepared arithmetic. Do not prefetch occupancy answers across potentially interacting commits.

Introduce a small occupancy-specific context instead of carrying the full movement context through every hot function. Load uniform constants once per job. Load cold recovery/path state only when that operation is actually required.

### Preserve cached ordering across slot relocation

The previous plan’s “invalidate cached order on slot compaction” would discard much of the benefit: slots are relocated frequently.

Instead:

- Cache per-block ID order as IDs and current slots.
- Maintain a reverse reference from the existing stable unit handle to its cache entry.
- Patch the cached slot during the existing slot-move operation.
- Patch the mover row’s slot and reverse map at the same time.
- Treat storage relocation as storage relocation, rather than removing and reinserting an unchanged unit.
- Rebuild or merge ordering only for genuine births, deaths and block transfers.

The existing slot-move operation uses independent source/destination pairs, making these patches compatible with its parallel execution.

For each tick’s movement ordering:

- Compute tile keys in vectors.
- Use fixed SIMD sorting networks for blocks with at most 16 relevant entries.
- Use one stable 256-bin counting partition for larger blocks.
- Preserve cached ID order within each tile.
- Allocate work through block ranges of population-sized buffers, avoiding fixed per-block item limits.

Histogram updates and scatter addresses remain small scalar administration where WASM lacks scatter instructions. Do not replace them with hundreds of redundant comparisons merely to increase the vector-instruction count.

### Simplify pressure arithmetic algebraically

Pressure steering only needs the signed lateral component:

```text
along   = dot(field, heading)
lateral = dot(field, perpendicularHeading)
```

Implement handedness and the lateral cap directly on that scalar component, four movers at a time. This removes the square root used to recover the magnitude of a two-dimensional lateral vector.

Calculate heading normalization once, reuse it for pressure, progress, shoulders and push deposition, and use squared comparisons where only a threshold is needed.

Keep ordinary `f32x4.sqrt` and division where they are required. Do not assume a bit-hack reciprocal square root will beat Edge’s generated instructions.

Additionally:

- Publish bilinear pressure coefficients with the frozen traffic field, so repeated sampling avoids four separate corner lookups for each component.
- Cache decoded push-response descriptors for the currently visited tile. Friendly-side vectors, average lateral position and hostile response magnitudes are tile-level calculations; standing units should not repeat those square roots.
- Preserve current speed modifiers, remaining-movement limits and give-way behavior.

### Keep swap winners in vectors

Replace the per-surviving-candidate scalar insertion loop with three vector-held ranks.

For every group of four candidates:

1. Evaluate geometry, owner, worker state, movement class, route exclusion and heading tests as masks.
2. Give rejected candidates an infinite score.
3. Insert each lane into that lane’s three best results using three fixed compare/exchange stages.
4. Compare `(score, stable ID)` to make ties deterministic.

After scanning the candidate lists, the global best three must be among those twelve retained entries. Extract those winners through a fixed reduction, rather than processing every survivor through scalar control flow.

Keep per-tile standing/walking candidate lists and conservative owner summaries. A rejected tile summary should prevent loading its candidate records at all.

Preserve working-worker protections, existing hop cadence and destination exclusions. Evaluate displaced-partner placements in SIMD packets; commit both participants together or leave both unchanged.

### Commit only changed bitmap bits

For each affected word:

```text
leaving  = oldMask & ~newMask
entering = newMask & ~oldMask

updated = (bitmap & ~leaving) | entering
```

Combine overlapping old/new words before writing. Do not clear the whole old footprint and then reload the same words to mark the new footprint.

For common short moves, the footprint union spans a small rectangle. Use contiguous `v128` accesses where the layout permits, and explicit word accesses at block seams. Keep mask alignment outside collision loops.

Replace the shared changed-slot atomic bitset with **one private bitset per executing worker**. Ordinary commits then mark local memory. Publication ORs the private bitsets in vectors over disjoint slot ranges.

This costs approximately `workerCount × capacity / 8` bytes and removes per-mover atomic operations. Merge order cannot affect the resulting set.

### Stop recounting the bitmap for traffic

Maintain an occupied-cell count for each existing coarse traffic cell.

- If both footprints lie wholly inside the same coarse cell, movement cannot change its count.
- Otherwise, update counts from the entering/leaving masks.
- Update the same counters on spawn, release, teleport and rebuild.
- Use atomic counter updates only in phases whose existing ownership permits concurrent updates to the same counter.
- Keep a diagnostic full bitmap recount to verify the invariant.

Traffic capture becomes a contiguous SIMD pass over counts and deposit data, rather than scanning the occupancy bitmap again.

Cache floor capacity and update it on wall-change events instead of recounting its sixteen game tiles every capture.

Pack each coarse-cell deposit as `[flowX, flowY, loss, padding]`. A vector load, saturating vector update and vector store replace three scattered scalar updates. Preserve deposit order and saturation semantics.

Resource accounting remains in its existing precision and canonical accumulation order. Final publication by physical slot must not accidentally reorder floating-point resource sums.

## 4. Integration and ownership rules

The end-to-end pipeline becomes:

```text
First-stage movement
    → compact records and eligibility
    → membership synchronization and cached ordering
    → packet preparation
    → four colored occupancy phases
         same-cell / short-field / medium-field / general traversal
         ordered commits, swaps and yielding
    → exceptional-envelope completion
    → private-bitset merge and final publication
    → SIMD traffic capture from maintained counts
```

Retain these invariants:

- Concurrent jobs have disjoint bitmap access regions, including whole vector words.
- Access bounds include patch assembly, displaced swap partners and push-deposit reach—not just destination footprints.
- Filter swap partners by immutable home membership before reading mutable state.
- Only geometrically independent movers may commit as a multi-mover packet.
- Moves outside the parallel ownership envelope run through an exclusively scheduled WASM batch after the colored phases. They are not dropped or capped.
- Newborns, unregistered footprints, inactive lanes and map edges have explicit WASM handling.
- All simulation completion stays in WASM, including spatial updates, wall recovery and required area-box work.
- JavaScript performs dispatch, synchronization and UI work.

Change every raw bitmap consumer together: birth placement, spawning, release, teleportation and traffic capture. Update slot relocation to copy eight record words. Version the shared configuration so stale bindings fail immediately.

For concurrent retirement, clear masks through aligned atomic subword operations; `v128` stores are not atomic. Keep retirement barriers separate from ordinary movement.

Account for all buffers and growth peaks before reserving memory. The 32-byte record saves approximately **30.5 MiB per million slots** compared with the previous 64-byte proposal. Include ordering caches, candidate lists, private bitsets, counters and tables in the actual reservation calculation. Do not lower population to make the new layout fit.

Implementation order:

1. Build and benchmark the legal-center and boundary-event kernels in a test-only Edge WASM harness.
2. Integrate the compact records, revision checks and relocation-aware ordering.
3. Migrate the bitmap and all consumers.
4. Replace short/medium traversal and then the general SIMD traversal.
5. Replace scalar swap ranking and repeated pressure calculations.
6. Introduce delta commits, private change masks and maintained traffic counts.
7. Complete final publication and remove obsolete production paths.

The first gate is the new resolver’s measured cost. A slower geometric core must be corrected before adding the rest of the integration.

## 5. Validation and performance gates

Read-only feasibility checks completed during this refinement:

- Boundary enumeration matched independent segment/cell clipping for **123,728 segments**.
- Packed legal-center construction matched direct footprint checks for **384,000 center tests**.
- Corrected floating-point quotient estimates matched integer results for **1,000,000 checked bounded inputs**.

These establish mathematical feasibility only. **No new Edge speedup has been measured, and no repository implementation has been changed.**

Run performance comparisons serially in headed, visible, stable Edge WASM32:

- Identical-input occupancy replay, including preparation and publication.
- Large mixed chaos gameplay with matched population, actions and simulation-step policy.
- `dk=1`, `4` and `20`.
- Single-worker diagnosis plus normal helper counts.
- Alternating baseline/new runs after warm-up, retaining raw measurements.

Measure complete pipeline time and each major component. Count field construction, field reuse, crossing events, general-path usage, swap candidates scanned, changed bitmap words and exceptional-envelope work. This distinguishes a fast inner loop from expensive preparation around it.

Correctness and behavior gates include:

- All radii 1–32 and all supported alignments.
- Exact grid-boundary starts and ends, negative directions, corner ties and zero axes.
- Equality between specialized and general geometry for overlapping supported cases.
- Sub-cell closing and gradual sideways movement—the previous walker’s counterflow failure must be covered explicitly.
- Map edges, block seams, large movements and failed swaps.
- Birth/death, teleportation, incremental relocation and full restore.
- Shuffled slots and mover rows.
- Exact peer hashes across 0, 3, 8 and 11 helpers.
- Existing wall, speed, plug and counterflow gates.
- Maintained occupancy counts equal a full bitmap recount.

Acceptance remains **complete occupancy time ≤25% of baseline**, with no overlap, wall or accounting failures. Preserve the previous behavior limits: no more than 5% loss of aggregate movement progress or five percentage points of fixed-time arrival fraction.

Retain further widening only when repeated Edge measurements establish a gain. Check register pressure, code size, preparation cost and tail latency; eight or sixteen logical lanes are not automatically faster.

Record each integrated stage, measurements and remaining bottleneck in [OPTIMIZATION_PROGRESS.md](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/OPTIMIZATION_PROGRESS.md).
