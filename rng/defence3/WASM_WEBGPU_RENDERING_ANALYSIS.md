# General TPS/FPS architecture, WASM/WebGPU viability, and responsive GUI plan

## 1. Direction and boundaries

**Your parallel work owns the specific simulation optimizations. This plan focuses on the surrounding architecture that can help those improvements reach players without introducing new bottlenecks.**

Historical siege timings and individual simulation functions will no longer determine this roadmap. Measurements will use the current simulation at the time of each experiment.

The work covered here is:

- Simulation, network, GUI, and renderer scheduling.
- Data layout, memory ownership, publication, and transfer costs.
- General WASM and WebGPU integration feasibility.
- Responsive local feedback with minimal overhead.
- Compatibility with the later rendering optimization plan.
- Development, deployment, determinism, and recovery requirements.

The priority remains deterministic 20 TPS. Rendering and feedback must fit around that requirement. There is no target to rewrite or optimize particular movement, combat, pathfinding, or resource algorithms in this workstream.

Before implementation, review your current changes and agree on shared interfaces through the code and tests. Avoid simultaneous changes to simulation internals; use adapters where practical.

## 2. General architecture and integration decisions

### Separate progress from presentation

Track four distinct milestones:

1. Authoritative simulation completed.
2. Required network/control work processed.
3. Presentation state applied.
4. Frame displayed.

This makes it possible to distinguish a slow simulation from a slow page, an expensive publication step, or a saturated GPU.

Split mandatory tick results from optional presentation work. Required hashes, protocol state, and recovery information must remain complete and ordered. Presentation snapshots may be coalesced, provided lifecycle information and recovery remain correct.

**Posting completion earlier is not enough:** optional packing on the same worker can still delay its next tick. Measure and control the complete publication path.

Use bounded queues and explicit ownership:

- Retain only the newest unconsumed presentation snapshot, plus snapshots actively in use.
- Never make simulation wait for rendering to return a buffer.
- Never allow rendering to read authoritative memory while simulation mutates it.
- Skip optional publication when a safe buffer is unavailable.
- Avoid unbounded allocations when consumers fall behind.
- Begin with recoverable full snapshots and incremental metadata, rather than requiring a delta-only protocol.

Audit existing network consumers before decoupling them from presentation state. A worker completing quickly does not solve a page that cannot process required networking.

### Establish a small shared data contract

| Contract | Required information |
|---|---|
| Mandatory completion | Match epoch, tick, required hash/control information, timing |
| Presentation snapshot | Epoch, sequence, source tick, entity identity/generation, transforms, lifecycle and appearance revisions |
| Local pending action | Local intent identity, existing network action IDs when available, requested display state, scheduling status |
| Renderer cache | Resource generation, uploaded revision, dirty regions, ownership and retirement state |
| Runtime compatibility | Authoritative rules version, numeric profile, snapshot schema, kernel ABI |

Keep backend-specific layouts behind these contracts. Simulation should not need to know whether the renderer uses WebGL, WebGPU, density markers, or detailed models.

Likewise, renderer cache knowledge must remain presentation-only. It records what the application has uploaded and which revisions are current; it does not expose physical GPU cache residency.

### General data and numeric improvements

Evaluate formats column by column, independently of algorithm changes:

- Narrow flags, enum values, bounded counters, and indices.
- Use integers or fixed point where their range and arithmetic are well defined.
- Use smaller floats where precision is sufficient.
- Retain wider storage for large resources, intermediates, and accumulators.
- Preserve residuals where repeated rounding would otherwise create systematic bias.
- Avoid maintaining multiple full representations unless their benefit exceeds conversion and synchronization costs.

A narrower array does not automatically make processing faster. Measure conversion, access patterns, alignment, memory traffic, and repeated packing.

Any authoritative numeric change must have defined rounding, overflow, ordering, and snapshot behavior. Presentation approximation remains separate from authoritative rules.

### WASM and WebGPU roles

| Option | Main opportunity | Main drawback | Planned position |
|---|---|---|---|
| Existing JavaScript and typed arrays | Lowest integration cost; benefits from improved layout and fewer passes | Performance depends on access patterns and runtime behavior | Baseline and reference |
| WASM scalar/SIMD | Dense computation over contiguous data, predictable memory layout | Boundary calls, copying, memory migration, and toolchain maintenance | First accelerator to investigate |
| WASM with existing helpers | Reuses current scheduling and CPU parallelism | Shared-memory ownership and per-worker runtime state need care | Preferred threading direction |
| WebGPU authoritative compute | Large, regular workloads with sufficient work per transfer | Determinism, readback, GPU contention, device loss | Gated investigation |
| WebGPU presentation work | Results can remain on the GPU for rendering | Broad backend migration and resource ownership changes | Later rendering option |

For WASM, prototype a small module using the existing helper pool. Avoid creating an additional pool by default. Existing independent shared arrays require a deliberate memory strategy; migration into WASM memory is a separate decision from whether a kernel runs faster.

For WebGPU, prioritize evaluating the whole pipeline: preparation, upload, dispatch, synchronization, readback, and consumption. Test with rendering active. GPU work that competes with rendering can worsen both simulation deadlines and perceived smoothness.

Authoritative GPU experiments initially use precisely defined integer operations and reductions. Floating-point approximation alone does not establish cross-device determinism.

Keep capability detection and backend selection outside active play. Clients with different implementations may share a match only when those implementations produce the same authoritative results.

## 3. GUI and rendering improvements that support TPS

The GUI audit remains relevant because it identifies architectural coupling rather than simulation algorithms.

| Area | General improvement | Why it matters |
|---|---|---|
| `+` / `−`, toggles, production controls | Patch a small local pending state immediately; reconcile through ordinary updates | Avoid waiting for simulation and rebuilding whole panels |
| Building placement and rally points | Bounded local ghosts and markers | Acknowledge intent without additional simulation work |
| Information and research panels | Show cached content immediately; refresh changed visible sections | Avoid large synchronous rebuilds on input or tick completion |
| Frame-count refresh schedules | Replace with dirty revisions and presentation deadlines | Low FPS should not multiply GUI refresh delay |
| Control groups and selection summaries | Cache membership and aggregates by explicit revision | Avoid repeated full-selection scans on unchanged frames |
| Picking and box selection | Share presentation spatial indexing with rendering | Avoid rebuilding world-wide candidate lists for each interaction |
| Minimap | Separate world-image refresh from camera-footprint drawing | Camera motion should not trigger repeated world scans |
| Health bars and text | Remove synchronous GPU depth readback from the normal path | Avoid blocking input and networking on GPU completion |
| Statistics, effects, and audio | Move optional work outside mandatory tick completion; bound and cache it | Keep presentation work from extending the control path |
| Selected-entity details | Immediate basic information, followed by coalesced optional detail updates | Avoid synchronous simulation queries |

A button update cannot become visible while its handler continues blocking the page. Large local operations therefore need bounded tasks and opportunities to paint, with mandatory network/control processing taking precedence.

Local feedback must remain cheap:

- One marker or summary per intent, rather than per-unit acknowledgement work.
- No new authoritative scans, required acknowledgement pass, or additional full snapshot.
- No duplicated simulation or pathfinding for previews.
- No authoritative state mutation.
- Pending does not mean accepted.
- Rapid repeated input uses the local projected value, avoiding repeated commands based on stale display state.
- Projected queue editing must preserve authoritative entry identity; index-based commands need special care before optimistic reordering is enabled.

### Integration with the later rendering plan

Retain the existing [rendering optimization plan](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/RENDERING_100X_INCREASE_ANALYSIS.md), including:

- Persistent GPU storage and dirty uploads.
- Spatial chunks shared by culling and picking.
- Generation-safe resource and entity identities.
- Paged terrain and bounded presentation caches.
- Density LOD and bounded effects.
- Correct 2D ordering and separate fog-history representations.

Bring forward only parts that remove demonstrated interference with TPS or establish necessary shared interfaces.

Extend existing interpolation rather than adding an unrelated smoothing layer. Use already-published state, preserve continuity across skipped snapshots, and make picking and focused overlays agree with the displayed pose. Avoid adding unnecessary buffering delay.

Under pressure, reduce optional detail and refresh frequency before sacrificing simulation progress. Separate workers help scheduling, but still compete for CPU cores, bandwidth, and GPU time; they are not performance isolation by themselves.

## 4. Exploration sequence and realistic estimates

These are rough **engineer-day estimates**, including focused validation, for someone familiar with the project. They exclude your simulation-specific work and do not promise a particular TPS improvement.

| Package | Exploration | Implementation if justified | Decision produced |
|---|---:|---:|---|
| Current integration baseline and latency instrumentation | 2–4 days | Included | Where time and backlog accumulate between simulation, page, and GPU |
| Bounded GUI refresh, caching, and minimap separation | 1–2 days | 4–8 days | Which inexpensive changes reduce page interference |
| Mandatory/presentation separation and buffer ownership | 2–3 days | 7–15 days | Safe decoupling without protocol or recovery regressions |
| Minimal local pending feedback | 0.5–1 day | 2–5 days | Immediate feedback within a bounded presentation cost |
| Remove blocking overlay readback | 0.5–1 day | 3–6 days | GPU-resident overlay solution and reduced-cost fallback |
| WASM feasibility prototype | 3–5 days | 10–20 days for initial integration | Whether end-to-end savings justify memory/toolchain changes |
| WebGPU feasibility prototype | 3–5 days | 15–30 days for one production subsystem | Whether benefits survive rendering contention and recovery requirements |
| Development and publication support | 1–2 days | 3–6 days | Reproducible builds, compatible assets, safe loading and fallback |
| Remaining rendering roadmap | 3–5 days of refreshed profiling | 20–45 days | Staged renderer improvements; no assumed 100× outcome |

The rows overlap and should not be summed mechanically. A useful initial allocation is **2–4 days of measurement**, followed by **15–30 engineer-days for a selected architecture/GUI tranche**. Re-estimate after that tranche; do not precommit to both accelerator integrations.

### Performance expectations

Use structural expectations first:

- Changing a world scan from every frame to 10 Hz reduces its invocation count by roughly 6× at 60 FPS.
- Revision caching can eliminate repeated work entirely on unchanged frames.
- Narrowing selected columns can reduce their storage and transfer bytes, but not necessarily total execution time proportionally.
- Removing readback eliminates a synchronization dependency; actual latency savings depend on the device and scene.
- WASM may provide a useful improvement or no net improvement after conversion and copying.
- WebGPU is most attractive when enough work is batched and results remain on the GPU.

For every experiment, report:

**Net benefit = work removed − preparation − conversion − transfer − synchronization − added contention.**

Keep a change when it produces a repeatable improvement in the intended metric without harming simulation/control performance. Accelerator prototypes should demonstrate a meaningful full-path benefit before expanding their scope. Stop unsuccessful branches within their exploration budget.

### Development and publishing

Keep static hosting. Add a pinned, repeatable WASM build command only if WASM is selected. Serve correct MIME types and keep local development/test behavior aligned with publication.

Version assets and compatibility metadata explicitly. Load and compile modules before active matches. Test cross-origin isolation, worker loading, shared-memory fallback, service-worker caching, and graphics-device failure.

Avoid update-driven reloads during active play. Determine the existing publication mechanism before deciding whether compiled artifacts are checked in or generated by its build process.

## 5. Validation and handoff with the parallel simulation work

Use the latest simulation implementation as the baseline for each comparison. Record the revision and local changes so concurrent improvements are not mistakenly attributed to this workstream.

Measure separately:

- Required simulation execution and synchronization.
- Presentation extraction/publication.
- Page control/network handling.
- Presentation application and GUI work.
- CPU rendering preparation, GPU time, and transfer volume.
- Input-to-visible-feedback and command-to-visible-result latency.
- Queue depth, memory growth, and long tasks.

Test normal, reduced, heavy, and stalled rendering; large selections; camera movement; open panels; rapid control input; and two peers where only one has heavy presentation load.

Validate frame coalescing, entity reuse, snapshot restore, resync, reconnect, host migration, and graphics loss. Compare authoritative outcomes across supported backends and helper counts.

Acceptance requires:

- No repeatable simulation or required-control regression from added feedback.
- No unbounded presentation queues or simulation waits on renderer-owned resources.
- Correct reconciliation of pending actions.
- Deterministic authoritative results under the chosen rules.
- Correct picking, visibility, and lifecycle behavior despite presentation approximation.
- Performance claims supported by current end-to-end measurements.

Deliver the work as independently reviewable interface, scheduling, GUI, and backend changes. Leave simulation-specific optimization decisions to your parallel work and revise integration assumptions as that implementation evolves.
