# Rendering performance and simulation isolation

Intended file: `RENDERING_PERFORMANCE_PLAN.md`

## Objective and architectural rules

Maintain stable 20 TPS wherever the same workload meets the 50 ms budget with rendering disabled. Target at least 60 FPS across the benchmark camera positions, without abrupt detail transitions.

- Simulation owns authoritative shared state and its tick clock.
- Visualization reads shared buffers independently. It never requests or waits for a simulation-generated presentation frame.
- No presentation encoding, decoding, full-population scans, buffer-return handling, or scene preparation on the simulation thread—including between ticks.
- Rendering may skip updates and tolerate approximate visual reads. Simulation never waits for rendering.
- CPU and memory bandwidth remain shared hardware resources; presentation workloads must be bounded and measured against the simulation-only baseline.

## 1. Remove simulation–presentation dependencies first

- Replace page-driven tick dispatch with a simulation-worker scheduler using absolute tick deadlines. Preserve command ordering, multiplayer sealed-tick requirements, pause, resync and speed controls.
- Remove page frame completion, presentation acknowledgements and page-applied tick counts from simulation scheduling and multiplayer performance feedback. Report worker-completed ticks separately from displayed ticks.
- Keep network transport and input handling lightweight on the page. Forward sealed commands immediately through a dedicated control channel; never through render processing.
- Remove the existing presentation metadata pump and legacy per-tick world-frame encoding from the shared rendering path. Do not replace them with another sliced scan on the simulation worker.
- Audit all remaining tick-result work. Gameplay hashing and network resync remain authoritative operations; HUD, minimap, visibility presentation, audio preparation and visual summaries leave that path.

## 2. Make shared state the visualization interface

- Reuse authoritative unit columns directly. Move required structure, projectile, terrain, visibility and player-summary fields into shared typed storage, updated where their underlying state changes.
- Represent type, style and other categorical values as numeric IDs with immutable lookup tables. Eliminate recurring object serialization and reconstruction.
- Publish a small atomic control block containing schema version, match epoch, buffer generation, completed tick, timestamp and active storage bounds. Send buffer bindings only at initialization or replacement.
- Use per-slot identity/generation checks to reject recycled entities. The visualization reader bounds-checks references and skips inconsistent entries without retrying indefinitely or blocking writers.
- Keep interpolation history and derived visual state exclusively in visualization-owned memory. No authoritative double-buffer copy each tick.
- Use a bounded shared event ring for transient visual/audio events. Overflow may discard cosmetic events; authoritative gameplay never depends on consumption.
- On reset or buffer growth, rebind by generation. Old visual work is discarded. Renderer failure stops or restarts visualization while simulation continues.
- Require shared-memory capability for this architecture. If unavailable, report the requirement explicitly; do not silently restore synchronous frame encoding.

## 3. One bounded visualization pipeline at every zoom level

- Run scene preparation and WebGL drawing in a dedicated visualization worker using `OffscreenCanvas`. The page retains controls and DOM updates.
- Send camera/input configuration independently; read world data only from shared buffers. Coalesce camera changes and process the latest state instead of accumulating frame jobs.
- Maintain reusable typed spatial indexes in the visualization worker. Cull chunks and entities before creating geometry, evaluating animation, preparing overlays or uploading GPU data.
- Use the actual 3D frustum and conservative entity bounds, including height and movement. An empty viewport must produce negligible scene work.
- Replace the global dots/detail switch with per-entity projected-size LOD:
  - Below 2 pixels: antialiased coverage glyph.
  - 2–8 pixels: colored type-specific impostor.
  - 8–24 pixels: simplified sprite or mesh.
  - Above 24 pixels: detailed representation.
- In 3D, calculate projected size at each object’s position; in 2D, use projected footprint. Preserve team colors, building type colors and recognizable silhouettes through every tier.
- Apply 20% threshold hysteresis and a 150 ms transition limited to objects crossing tiers. Bound detailed rendering by visible screen coverage and frame budget.
- Batch persistent GPU instances and reuse staging storage. Restrict uploads to necessary active data; remove per-entity transient allocations and full-world page wrappers.
- Budget combat effects by projected coverage, distance and visibility. Aggregate distant effects and cap overdraw.
- Address distant banding with stable depth precision and antialiased subpixel coverage; verify terrain, structures and units retain correct occlusion.
- Produce HUD summaries and minimap data on the visualization side. Refresh ordinary DOM statistics at 5 Hz, preserving immediate selection and command feedback.

## 4. Validation and completion gates

Extend the browser benchmark before claiming improvement:

- Test 10k, 50k and 100k units **per team**, recording total entities explicitly.
- Test every map visibility mode (menu: Full visibility, Team, Team + history): each changes the work on both sides (sight grids, fog history, what is drawn). `tests/render-tps-bench.cjs` runs all three by default (`VIS=full,team,history`).
- Compare rendering disabled/enabled on identical seeded idle, moving and combat workloads.
- Include 2D and 3D far views, continuous zoom through every transition, close views, an empty viewport, and the requested close tilted-up view containing both armies.
- Warm up for 10 seconds; measure each case for 60 seconds without DevTools profiling. Collect CPU/GPU profiles separately.
- Record actual worker TPS, tick computation and deadline lateness, presentation age, frame p50/p95/p99, preparation/upload time, draw calls, visible counts and memory.
- Require sustained 20 TPS for qualifying baseline workloads, with no more than 5% increase in p95 simulation computation time. Target p95 frame time ≤16.7 ms on the benchmark machine.
- Pause visualization for two seconds: simulation must continue independently when commands are available. Repeat with renderer failure and a stalled page under prequeued commands.
- Validate multiplayer pacing, deterministic gameplay hashes, fog, selection, spawning, death, slot reuse, resizing, reset and resync.
- Run a ten-minute camera/combat soak: memory must plateau and presentation queues must remain bounded.

Implement and validate simulation isolation first, then shared-state coverage, then the unified renderer and visual polish. Far-view FPS alone is not a completion criterion.
