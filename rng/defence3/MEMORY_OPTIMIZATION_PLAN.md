# Reduce memory traffic at 200k×2 and 400k×2 units

## Summary

Optimize in this order: **remove repeated passes → shrink hot fields → allocate specialized state only where needed → process active subsets → reduce snapshot and presentation copying**.

The current numeric unit store contains **172 distinct columns, totaling 834 bytes per slot**: approximately **318 MiB at 400k units** and **636 MiB at 800k**, excluding objects, scratch buffers, and presentation data. Allocation also includes a duplicate `mvHTT` entry.

Precision and layout changes are allowed. Multiplayer determinism remains mandatory across JS/Wasm, helper counts, restores, and different browsers. The reported 105 ms tick time at 400k total units is historical context; establish a fresh baseline before implementation.

## 1. Establish measurements and a shared storage contract

- Extend the existing tick benchmark to report allocated/live bytes by subsystem, capacity utilization, units visited per pass, active-mode counts, and estimated bytes read/written per tick. Clearly distinguish modeled traffic from measured hardware bandwidth.
- Benchmark **400k and 800k total units**, with identical settings and seeds: idle, moving, active workers, and mixed combat. Use seven helpers for the primary comparison and repeat with zero and three to expose synchronization and bandwidth effects.
- Measure headless multiplayer and Edge multiplayer separately; presentation traffic competes with simulation traffic even when it runs on another thread.
- Introduce one column schema describing type, default, sentinel, storage group, and snapshot meaning. Generate or validate JS allocation, Rust pointer types, and ABI bindings from it. Reject duplicate declarations.
- Keep IDs, unit slots, tile indices, path nodes, generations, and ticks at 32 bits. The target populations and million-tile maps rule out general 16-bit indexing.

## 2. Remove redundant work and narrow the hot state

**Fuse movement scheduling first.**

Combine `MOVE_STEP` and `MOVE` into one scheduled job per slot range. Run the committed-step fast path first, then the general path for remaining units while their data is still nearby. Keep specialized routines to avoid rebuilding the large JS function that previously caused compilation problems.

Replace the full-array step stamp with job-local classification; remove `mvStepT` after both paths share that classification. Preserve pass-start target reads, deferred hit resolution, and deterministic commit ordering.

Have movement produce lists for its epilogue: units that changed tiles, spent movement budget, need object handling, or fired. Stop rescanning all completed units for these events.

**Shrink storage using this policy:**

| State | Planned representation |
|---|---|
| Positions, previous/pass-start positions, velocities, committed steps | Float32 |
| Radii, speed, lane offset, geometric ranges/distances, separation carries | Float32 |
| Worker and forced-target coordinate caches | Float32 |
| Command state | Uint8 |
| Owner and cached spatial owner | Int16, retaining `-1` |
| Path index | Int32 |
| Energy, damage and damage accumulators, resource accounting | Retain Float64 |
| Levels/stacks and timers with fractional or unbounded semantics | Retain existing types initially |

Use **Float32 storage with Float64 intermediate arithmetic** in both JS and Rust. Round at identical writes, including object fallbacks and cache construction. Do not switch Rust expressions wholesale to native Float32 arithmetic.

The 32 identified geometric Float64 columns offer **128 bytes per slot** of storage reduction—about **49 MiB at 400k units** and **98 MiB at 800k**, before shrinking their downstream copies.

Remove the duplicate `mvHTT` declaration and the declaration-only `mvHOT`/`mvHOZ` fields. Pack flags only when they share update ownership; independently written flags must not share a read-modify-write word across helpers.

## 3. Separate specialized state and process active subsets

**Retain contiguous SoA storage for common fields.** Avoid converting the entire simulation to an array of large structs.

- Move the **16-node path window** into a compact pool used only by explicit-path movers. Store a 32-bit pool index per unit. Keep nodes Int32. Flow movers no longer reserve 64 bytes of path nodes each.
- Move worker search/parking fields into worker-only sidecars and forced-target rollback fields into sidecars for units using that feature. Use typed-array pools with reverse mappings, generation checks, and deferred reuse until background readers finish.
- Allocate and release sidecars on state transitions. Rebuild derived pools after restore; pool order and addresses must never determine gameplay order.
- Keep per-unit hot movement parameters initially. Avoid replacing every hot load with a scattered lookup into shared stat tables.

Maintain active lists for status effects, running cooldowns, movers, held attackers, and due worker checks. Producers update membership; do not rebuild every list through a new full-unit scan each tick.

For each phase:

- **Statuses:** visit affected units and units with pending damage reports. Remove unconditional accumulator and event writes for unaffected units.
- **Separation:** record self-movement during position commits. Finish only units with contacts or carried pushes, including both participants in a contact.
- **Spatial counts:** consume changed-slot lists from movement and separation, retaining the first old chunk and final new chunk.
- **Parked units:** schedule existing wake/check ticks and invalidate on relevant floor, navigation, status, or work changes. Preserve current check cadence and immediate triggers.
- **Object work:** merge candidate lists into the existing deterministic unit traversal order.

Use per-job event buffers and deterministic merges. Every bounded buffer must have a lossless overflow path. Dense workloads use sequential traversal when list density exceeds 50%; sparse and dense paths must produce identical results.

## 4. Reduce acquisition, snapshot, and presentation copies

The existing pass-start position copy and tick-end presentation position copy together move approximately **38.4 MB per tick at 400k units**, or **76.8 MB at 800k**, counting reads plus writes. Presentation adds further copies.

- Convert acquisition coordinates, presentation motion snapshots, and presentation motion scratch buffers to Float32 alongside authoritative geometry.
- Build acquisition’s immutable spatial-order coordinate records directly from source columns. Remove the intermediate slot-order coordinate copy; retain compact slot-to-entry mapping where commit logic requires it.
- Preserve separate pass-start positions initially: `x0/y0`, interpolation positions, and live positions represent different moments and cannot simply be aliased.
- Keep immutable presentation publication and buffer ownership. Split stable metadata from dynamic motion/status data; send metadata and membership changes by revision instead of copying them into every frame.
- Publish presentation motion only when the consumer requests another snapshot. Slow or hidden pages may skip visual updates without delaying simulation or changing its state.
- Retain hash coverage and cadence. Cache region membership at position commits and maintain regional slot lists so hashing a region slice does not require reading every unit’s coordinates. Keep logical field hashing independent of storage layout.
- Replace blanket doubling in large scratch pools with reservation from expected population plus 12.5% growth headroom, rounded to allocation blocks. Report live bytes and committed Wasm heap separately.

## 5. Determinism, compatibility, and acceptance

Introduce a **simulation-rules revision** carried through join/start, snapshot, patch, and reconnect paths. Reject mixed revisions before simulation starts. Legacy saves load through explicit normalization into the new numeric representation; historical replay identity is not required.

Storage accessors remain logically compatible. Update Rust kernels, object paths, snapshot decoding, hashing, and presentation bindings together. Preserve negative sentinels, absent values, stable target tie-breaking, and ordered floating-point reductions.

Validation must include:

- JS/Wasm kernel byte comparisons, extending coverage to movement, packed fields, and sidecars.
- Kernel/object equivalence and multiplayer determinism with different helper counts.
- Late join, patch/resync, host migration, slot reuse, compaction, and outstanding background jobs.
- Fractional cooldowns, tiny damage against large energy values, map boundaries, overlapping units, status expiry, and dense event-buffer overflow.
- Edge multiplayer in Full, Team, and Team + history visibility modes.
- Three sequential benchmark repetitions per primary workload, comparing the same simulated tick interval after warm-up.

Land stages independently. Require zero desyncs and no unexplained performance regression above 5%. Target at least **30% lower modeled traffic in the affected hot phases**, while judging success by end-to-end tick time and presentation stability. The existing 50 ms goal remains a performance objective, not a promised consequence of footprint reduction.
