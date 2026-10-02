# Refined rendering plan: 200k units / 40k buildings

## 1. Target, baseline, and architectural constraints

Optimize both 2D and 3D using the existing WebGL2 renderer. Preserve close-up appearance; use adaptive representations where individual units are indistinguishable.

**100× remains a measured stretch target.** First deliver 60 FPS on the baseline machine, with p95 frame work below 16.7 ms. Report renderer speedup and end-to-end FPS separately: snapshot application, visibility presentation, UI, and simulation scheduling can otherwise hide the rendering gain.

The deeper scan establishes these constraints:

- Existing 3D layers already interpolate on the GPU. Extend them rather than replacing that mechanism.
- Flat 2D preserves painter order with depth testing disabled. Chunk/material sorting must not silently change overlapping sprites.
- `getLiveRenderView()` can return live entities mixed with frozen visibility-history ghosts.
- Atlas layers are recyclable. Persistent instance records cannot treat a texture-layer number as a permanent reference.
- Frame application currently rebases previous positions to the last displayed interpolation. Incremental updates must preserve that continuity.
- Terrain canvases use world dimensions. At 1,000 tiles across and 32 pixels/tile, one RGBA surface is approximately **4.1 GB**, before additional surfaces or mipmaps.

No implementation or browser performance measurements have been performed during this planning scan.

## 2. Shared presentation data and incremental updates

### Frame contract

Extend the existing unit and structure frame formats rather than introducing per-entity messages.

Each published frame carries:

- Epoch, sequence, and previous sequence.
- Existing stable slots and entity identity; structures retain their serial/generation.
- Typed lists of created, removed, transform-changed, and appearance-changed slots.
- Render-chunk membership and revisions.
- Separate visibility/light revisions and changed regions.

Start with **full authoritative frame columns plus incremental presentation metadata**. This retains recovery and existing page views while reducing rendering work. Do not introduce delta-only transport in the first version.

Compute changes against the previously published values during frame encoding, after helper writes finish. Compare stored typed values, avoiding false changes from float conversion. Avoid new simulation mutation hooks distributed throughout unit logic.

Changed categories must remain narrow:

| Change | Required work |
|---|---|
| Position/facing | Transform update and possible chunk relocation |
| Health/status/level/type | Relevant overlay or appearance update |
| Visibility/light | Visibility membership or lighting update |
| Camera | Visible chunks, projected size, draw uniforms |
| Selection | Selection overlays and picking metadata |
| Tick/time advance | Animation uniforms; no blanket geometry invalidation |

A changing walk phase or production timer must not invalidate a whole model or exact panel when the shader or a progress primitive can express it.

### Ownership and recovery

- Preserve existing immutable-frame ownership and buffer-return rules. GPU uploads still copy data; shared memory does not make them free.
- Apply presentation deltas in sequence. If frames are coalesced for display, union changes and removals across every skipped sequence.
- Preserve gameplay events, hashes, and frame application order independently of rendering.
- On missing sequence, epoch change, restore, or identity mismatch, rebuild from the newest full frame.
- Treat identity as epoch + slot + entity ID/generation. Never reuse cached appearance solely because the slot number matches.
- Retain the existing interpolation clock. Rebase only previously moving and newly moving slots, updating their GPU records even when authoritative position changes alone would not flag them.
- Explicitly reset previous-position deltas when movement ends. Teleports retain their current hide/snap behavior.

For the non-worker mode, expose the same presentation interface from local state.

## 3. Spatial traversal, persistent drawing, and resource lifetime

### Spatial representation

Use 16×16-tile leaf chunks with a hierarchy above them for coarse rejection and distant summaries.

- Maintain chunk membership during frame encoding; the page consumes revisions without rebuilding an index every rendered frame.
- Bounds conservatively include previous/current positions, footprint, height, and attached visuals. Query neighboring chunks where interpolation crosses boundaries.
- Query chunks before entity appearance, panel, and instance work.
- Use explicit live and remembered namespaces. Ghosts retain frozen appearance and position until existing visibility-history rules remove or replace them.
- Preserve current gameplay visibility and presentation fade/hold semantics. Aggregation must use the same eligible entities as ordinary rendering.
- Long beams, selection lines, and other spanning effects have their own bounds; they cannot be culled solely by their source chunk.

Optimize visibility-history maintenance as part of this subsystem: update changed entities and affected visibility chunks instead of rebuilding every displayed list each tick. Keep fading/hold-expiry chunks active until transitions finish.

### Persistent 3D storage

- Keep dense instance buckets by chunk, model, material, and LOD.
- Maintain slot-to-bucket mappings. Opaque removals may swap with the last record; update the moved record’s mapping immediately.
- Retain GPU allocations and upload merged dirty ranges. Use a full bucket upload when more than half its records changed.
- Remove the current bucket-to-monolithic-array copy.
- Keep transforms, appearance, and time-driven activity separable. Unchanged buildings survive tick boundaries.
- Preserve a separate ordered path for transparency; do not apply opaque compaction or arbitrary sorting to it.
- Cache picking metadata with the bucket. Camera updates should not copy every pick entry.

Avoid turning thousands of chunks into thousands of draw calls. Use coarse summaries for distant chunks and combine compatible visible ranges when submission exceeds the draw budget.

### Persistent 2D storage and ordering

Store flat instance records in a persistent GPU data texture indexed by render slot. Supply a compact ordered list of visible slot indices to the vertex shader.

- Fetch positions and appearance by slot; interpolate previous/current positions using the frame alpha uniform.
- Preserve existing entity painter order and layer order. Build the visible ordered list from chunk candidates, not from a global per-frame scan.
- Rebuild that list only when visible membership or order changes.
- Batch texture-array sprites without sorting by material. Preserve ordered fallback runs for non-atlas textures.
- Merge adjacent texture updates and split updates correctly at texture-row boundaries.

This avoids choosing between persistent storage and correct overlap ordering.

### Atlas and memory management

Introduce explicit atlas handles containing layer and generation, with reverse references to affected buckets.

- Pin layers referenced by active draw lists and both sides of an LOD transition.
- On eviction or atlas reallocation, invalidate dependent records before drawing.
- Limit cache-miss work. If a detailed panel is unavailable, draw the shared body and status primitives immediately; do not fall back to one texture/draw call per entity.
- Share immutable body sprites by visual variant. Represent health bars, progress bars, damage flashes, and text separately.
- Use reusable geometric capacity growth for buffers; release all caches on match teardown and rebuild GPU resources after context loss.

Replace world-sized terrain canvases with 512×512-pixel pages covering the 16×16-tile chunks, plus a low-resolution overview. Upload dirty pages and visibility regions only. Add border gutters to avoid filtering seams.

Initial presentation-cache budget: **256 MiB**, divided into 128 MiB textures, 64 MiB CPU raster caches, and 64 MiB instance/index storage, excluding existing authoritative frames and screen-sized targets. Evict offscreen resources first; simplify representation when the active set exceeds budget.

## 4. Adaptive detail, effects, minimap, and interaction

### Representation rules

Use projected CSS pixels, independent of DPR:

- **Above 12 px:** current close-up representation.
- **3–12 px:** shared sprites/minimal geometry; no unreadable labels or detailed panels.
- **Below 3 px:** density markers with owner composition, count, and dominant type.
- Apply 15% hysteresis and replace representations atomically so an entity never disappears between tiers.

Start density cells at 4 px and enlarge them until no more than 20k markers remain. Anchor summaries to stable world regions and reuse them between ticks. Camera movement should project existing summaries rather than repeatedly binning all entities.

Dense overlapping views also need aggregation even when nominal model size exceeds 3 px. Use coarser representation when a projected region contains more than eight overlapping eligible units.

**Refinement to the earlier plan:** mass selection cannot exempt every selected unit from aggregation. Keep hovered units individually detailed; show selected composition/count and aggregate outlines at distance. Preserve exact selection membership and commands.

### Effects and shadows

- Omit individual shadows below 12 px; retain near shadows and existing quality options.
- Cap submitted decorative effects at 10k primitives, using stable-ID sampling and spatial merging.
- Keep attack direction, important impact locations, and hovered-unit feedback readable.
- Never remove simulation events to satisfy a visual budget.
- Rate-limit optional panel rasterization to 2 ms total per frame; preserve readable placeholders while detailed assets warm.

### Minimap and UI

- Refresh minimap content at most 10 Hz; draw the camera footprint separately every frame.
- Cache fog by changed regions. Aggregate units into minimap pixels with owner composition.
- Coalesce content rebuilds instead of queuing them. Alerts remain independent.
- Update HUD and control-group DOM only when displayed values change.
- For mass selection, cache summaries and contours; aggregate destinations rather than allocating a line per unit each frame.
- Picking and box selection query exact spatial candidates, then use existing geometric tests. Density markers do not become replacement gameplay entities.

Keep camera/input feedback current even while optional detail work is delayed. Do not time-slice visibility correctness or removals.

## 5. Implementation sequence and acceptance gates

| Stage | Deliverable | Gate |
|---|---|---|
| 1 | Scale benchmark, phase counters, minimap/UI fixes, reusable scratch storage | Establish reproducible baseline and attribute stalls |
| 2 | Shared presentation contract, chunk queries, indexed ghosts and overlays | Offscreen population growth does not increase normal frame traversal |
| 3 | Persistent 3D and ordered 2D storage, interpolation-safe dirty uploads | Unchanged records survive ticks; camera movement avoids mass uploads |
| 4 | Atlas lifetime tracking, paged terrain/fog, bounded caches | No wrong textures, allocation churn, or memory growth during repeated pans |
| 5 | Density LOD, bounded effects, scalable selection | Target-scale stress matrix meets frame budget |

Retain old/new presentation paths behind a development setting for identical-state comparisons. Enable the optimized path by default only after the acceptance gates pass. Defer a render Worker or backend migration until measurements demonstrate a remaining need.

### Benchmark matrix

Use seeded 200k-unit / 40k-building states with:

- Mostly offscreen entities, dispersed visible entities, and dense all-visible armies.
- Idle, movement, combat, production, and mass selection.
- Pan, zoom, rotation, mode switches, cold caches, and sustained camera movement.
- Fog/history enabled and disabled; full visibility; DPR 1 and 2.
- Both paused-state rendering measurements and normal worker-driven play.

Measure CPU phases, GPU time, uploaded bytes, draw calls, cache misses, memory, and input delay. Use GPU timer queries asynchronously; reject disjoint samples. Reserve `gl.finish()` for diagnostic throughput checks.

### Correctness and regression tests

Cover:

- Birth/death, slot reuse, restores, sequence gaps, and burst arrivals.
- Chunk crossings, stopping, teleports, and interpolation continuity.
- Ghost freezing/removal, visibility fade expiry, and hidden effects.
- Atlas eviction/reallocation and context recovery.
- Overlapping 2D sprites, transparent 3D objects, and LOD transitions.
- Exact picking and mass selection under aggregation.
- Terrain/fog page seams, camera overscan, and bounded cache lifetime.

Run existing renderer, selection, visibility-history, picking, and frame-stability regressions. Add work-count assertions alongside timings: a stationary frame must not scan all entities, rewrite unchanged instance buffers, or recreate panels.

Report speedup per scenario against the original baseline. A 100× improvement must be demonstrated directly; isolated gains are not multiplied together.
