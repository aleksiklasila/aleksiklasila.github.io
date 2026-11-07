# Perf-fuzz spikes on the 1M chaos scene (2026-11-07)

Findings from the 60-minute perf fuzz in the full validation run, for
follow-up work. Nothing here is fixed yet. Ordered by severity: tick stalls
(every multiplayer peer waits), then long page frames, then steady costs that
lower the baseline.

## The run

- `node tests/perf-fuzz.cjs scenes/chaos-1m-250k.gz --minutes=60 --headless --seed=20261103`
  (job `perf-fuzz-large` of `tests/run-full.cjs`), headless Edge 156, RTX 2060,
  wasm32, 1600x900, commit 7e7dfb9 + the 2026-11-07 test fixes.
- Scene: the re-exported `tests/scenes/chaos-1m-250k.gz`: 1,000,004 units,
  65,536 structures (32,768 per team), map 1024. The armies fight at once, so
  the population falls from 1M to ~480k by the first trials and ~50-180k later.
- Raw data (local only, `tests/test-runs/` is git-ignored):
  `tests/test-runs/full/2026-11-07T11-15-26-817Z/perf-fuzz-large/`:
  `report.md`, `trials.jsonl` (every trial's base/during/tail windows),
  `profiles.jsonl` (per profiled trial: busy ms against an idle control window,
  per thread), `profiles/*.cpuprofile` (page and every worker), `run.log`, and
  `sim_wasm_bin.js`, the exact wasm build the profiles were taken with.
- Resolving the profiles' wasm frames: `node tests/profile-attrib.cjs <run>/sim_wasm_bin.js <run>/profiles <file regex> [frame regex]`.
  It names exported kernels and attributes the stripped internals
  (`wasm-function[N]`) to their kernel. Use that run's `sim_wasm_bin.js`,
  because a rebuild renumbers the functions.

How to read the numbers:
- **gap**: the longest time between two applied ticks. For a stall, compare it with the
  trial's base gap p95.
- **Trial numbers** restart in each of the three sessions: s0 #24 is session
  0's trial 24 (`trials.jsonl` field `session`; in `profiles.jsonl` the
  sessions follow one another).
- **+ms**: the extra busy time of a function in the profiled repeat of the trial, over the idle
  control window of the same length.
- Cumulative totals sum every profile, control windows included, so they show steady cost.
- The match runs at 2-20 TPS here, not 20, so a gap of 1-2 ticks is normal.

## Baseline (not a spike): the idle match runs at 2-4 TPS at ~480k units

- TPS p5 / p50 / p95 over the hour: 3.2 / 10.1 / 20.2. TPS was below 15 for
  56% of the samples. FPS p50 was 92.
- At ~480k units the sim tick takes 100-350 ms; at ~130k, ~55 ms; at ~50k,
  ~25 ms. Every simulation thread is busy nearly the whole time.
- Where it goes (all simulation threads together, all profiles): the
  movement kernels. `mv_move_occupancy` and its internals (wasm functions
  101, 122, 17, 109, 18 and 19) take ~130 s. `mv_move` takes 13.6 s and
  `mv_flow_exact` 6.3 s. On the simulation thread, `simParallelRun` self
  time (waiting for helpers) is ~15 s, mostly under `simMoveRun`.
- This is the 1M-unit throughput target, not an interaction spike. It is
  listed because every number below sits on top of it.

## Tick stalls

### S1. q / e (resize the selection: halve / double), 2-5 s without ticks

- Trials (all session 0): #24 `order.resize` (82k selected, 85k units), gap **2311 ms**, sim
  max 2304 ms. #25, the profiled repeat (168k selected), gap **4024 ms**.
  s0 #61 (q/e x4 + bottom bar + keys, 222k selected, 407k units), gap
  **5025 ms**. TPS then stayed at 0-0.6 for 40 s ("persistent", not
  recovered). #59 (q/e x3), gap 2023 ms, then one tick of 5005 ms.
- Simulation thread profile (s0 #25):
  - `occ_spawn` 1995 ms, plus its internal search (function 19) 1413 ms;
  - `_spawnTplWrite` 260 ms; `_simUnitSlotStart` 249 ms;
    `spawnUnitNearUnit` 123 ms; `simSpawnUnit` 92 ms; `k_slot_zero` 79 ms.
  - Call path for all of it: `processAction` (main.js) → `_unitResizeKernel`
    → for each new unit `spawnUnitNearUnit` (unit.js:2160) → `simSpawnUnit`
    → `occupancySpawn` (sim_occupancy.js:60) → `occ_spawn` (wasm).
- Cause: `k_unit_resize` decides the groups in one kernel call. Then
  `_unitResizeKernel` (main.js ~5045) spawns every new unit one at a time from
  JS. For each new unit:
  1. A JS tile search: `canUnitOccupyTile` over 12 neighbours, then
     `findNearestWalkable`.
  2. A full JS spawn: template write, slot start, `k_slot_zero`, spatial
     update.
  3. One `occ_spawn` wasm call, which searches up to 32 cells outward for
     free occupancy.

  Doubling a dense army spawns tens of thousands of units in the same crowded
  spot. Each search starts next to its template, so later units scan farther
  through cells already filled. That makes the search cost grow faster than
  the unit count. This is the per-unit JS loop that the hard rule (wasm, no JS
  fallbacks) forbids.
- Measurement caveat: in #25 and #61 the trace shows ticks of 64 ms or less
  while no tick arrives for 4-5 s. The resize runs in action processing, and
  that work was not counted in `sim` there. In #24 it was (2304 ms).
  Per-phase traces need to include action processing.
- Direction: spawn and place the new units in wasm, batched, inside
  `k_unit_resize`'s second phase or one dedicated kernel. That means slot
  allocation, template stats, and occupancy placement as one pass, with a
  shared frontier per template group instead of one 32-cell search per unit.
  It also means no per-unit `simSpawnUnit` or `occupancySpawn`.
- Also check: after #61 the match stayed at 0.6 TPS for 40 s. Partly that is
  more units, since e doubles the army. Check whether something else is left
  behind, such as occupancy relocations or flow re-arming for all the new
  units.

### S2. Stop / hold on a big selection: 1.76 s gap, no profile

- s0 #62 `order.stopHold` (115,898 selected, 478,669 units): base gap 1503 ms
  (0.7 TPS), tail gap **1761 ms**, sim tick mean 100 → **229 ms** (max 353)
  for the ticks after the stop. Recovered in 16 s. The combo s1 #46 (stopHold +
  rapid orders, 45k selected): sim 24 → 271 ms.
- Not profiled (the fuzzer profiles one trial per kind of finding). Suspects:
  the stop path for 115k units (`k_unit_cmd` stop → `k_order_workers` mode 2
  for workers), then movement re-planning and flow re-arming in the next ticks
  for every stopped unit.
- Next step: reproduce with `scn`/`order.stopHold` on the scene, with
  `?simtrace=1` per-phase data and a simulation thread profile.

### S3. Box select at 478k units: 847 ms gap, no profile

- s0 #69 `select.boxBase` (box over the base, 478k units): gap **847 ms**
  against a base p95 of 203 ms. TPS after: 19.9 → 2.9. No order was given,
  so a box selection alone stalled the ticks.
- Suspect: the page's box-selection work holding the main thread, which stops
  ticks being dispatched (see S5 and S6), or the simulation thread's
  end-of-tick details (S4). Needs a profile.

### S4. End-of-tick details on the simulation thread: a scan over all units

- Seen in most selection trials. s2 #11 (thrash + minimap order + box all):
  `simFrameDetails` **+711 ms**, `get id` (unit.js:574) **+588 ms**,
  `get` (data_state.js:1913) +266 ms, `_simPostResult` +219 ms, all on the
  simulation thread. Cumulative across profiles, under `_simPostResult`:
  `get _routeKey` 2106 ms, `get` data_state 1625 + 1369 ms,
  `simFrameDetails` 1522 ms, `get id` 874 ms.
- Cause: `simFrameDetails` (sim_frame.js:339) runs after every tick for up to
  512 watched units. That is the page's detail panel and path lines. When a
  watched unit is not at its remembered slot, it is looked up by
  `for (let c of units) if (c.id === id)`. That is a full scan through the
  `units` Proxy (data_state.js:1913) per missing unit. A watched unit is
  missing when it died, or when slot relayout or compaction moved it. In a
  big fight with 512 watched units that is up to 512 × ~480k proxy reads in
  one tick. After that come the per-unit JS field reads (`SIM_DETAIL_FIELDS`,
  `unitDisplayPath`). The `_routeKey` frames appear under the same
  `_simPostResult` and are probably the same loop, attributed through
  inlining.
- Direction: resolve the watched ids through the unit id index
  (`UnitIdIndex`, O(1)) and drop dead ones. Build the details from columns in
  one pass, or in a kernel, instead of per-unit JS getters.

## Long page frames and blocked input

These lower FPS and input latency. A stalled page main thread also delays
dispatching ticks in multiplayer (S3).

### S5. Big selections on the page (frames up to 416 ms)

- s1 #8 `order.rapid` (133k selected): frame **416 ms**, task 302 ms.
- s1 #15 `scn.holdBigSelection`:
  - `selectionIndex` (hud.js:3360) **+1185 ms**;
  - the anonymous function at sim_client.js:1157 **+584 ms**;
  - `pushMarker` (renderer.js:1046) +312 ms; `getOrderMarkers` +239 ms;
    `declutterOrderMarkers` +237 ms;
  - `keep` (info_panel_static.js:614) +280 ms.
- s0 #8 (`scn.bigSelectRally`):
  - `_simClientApplyFrame` +533 ms; `selectionIndex` +435 ms;
    `keep` +328 ms;
  - `selectionCompactDead` +266 ms; `applyUnitCommandTargets`
    (main.js:1883) +255 ms.
- Causes:
  - `selectionIndex` rebuilds its slot list and mask with a pass over the
    whole selection array (PageUnit objects, `u._s`). It does that whenever
    the array or its length changes, and `selectionCompactDead` changes it
    (every 2 s for 100k+). The cost is O(selection) per change, and the
    getter is called from the overlay builder (`getSelectionMaskOverlay`).
  - sim_client.js:1157, on a slot remap (restore, first frame):
    `selectedUnits.some(...)` and `.map(...)` over the selection.
  - `keep`: `Array.from(ids)` turns the info-pack worker's typed id lists
    into JS arrays, three per selection change (all, combat, workers) at up to
    200k+ each. That is JS heap and GC pressure.
  - Order markers: `pushMarker` builds a string key and a Set entry for every
    marker every frame. `getOrderMarkers` and `declutterOrderMarkers` run per
    frame over the selection's order targets.
- Direction: keep the selection as slots and ids in typed arrays rather than
  a JS array of objects. The index then becomes the store itself. Keep the
  packer's id lists typed. Build the markers once per order or selection
  change rather than every frame, keyed numerically.

### S6. Info-pack worker on big selections (off the page, 1-5 s busy)

- s0 #12 `select.thrash`: info-pack worker busy 5016 ms against 507 ms idle.
  The extra time: `hit3d` (info_pack_worker.js:553) +1209 ms, `unitBinPass`
  (:308) +835 ms, `selectionIds` (:595) +556 ms, `proj` +371 ms.
- s1 #15: `unitBinPass` +1118 ms, `enc` (:613) +424 ms, `stat` +200 ms,
  `put` (id_codec.js:18) +170 ms, `radixSort` +152 ms.
- s0 #8 (big select + rally): `unitBinPass` +1012 ms, `selectionIds` +992 ms, `actionIdsEncode`
  +531 ms.
- It is a worker, so it does not block frames. But the info panel and the
  order id lists arrive late, and S5's `keep` follows each message.
  `selectionIds` sorts and encodes every piece again on each selection change
  (`p.slice().sort()` + `actionIdsEncode`). `hit3d` projects every unit for a
  3D box selection.
- Direction: incremental bins, and encoding only for orders (lazily, or
  in wasm). A 3D box select from the presentation frame's screen positions
  instead of a per-unit projection.

### S7. Presentation worker fills on change bursts

- s1 #15: `fillRange` (presentation_worker.js:168) **+1683 ms**,
  `markDirtySlots` (:551) +1159 ms, `frameIdOrder` (:431) +657 ms,
  `buildRenderBuckets` +248 ms.
- s1 #17 `scn.economyStorm`: the presentation helpers #3 and #4 add +665 ms and
  +529 ms in `fillRange`, against 70-90 ms idle.
- s1 #13: `fillRange` +482 ms, `markDirtySlots` +309 ms, `frameIdOrder` +243 ms.
- These are the changed-slot copies. A big selection or order changes every
  selected unit's command and flash columns, so it dirties every slot.
  `frameIdOrder` uses a native numeric sort of id·2^b + slot; the project's
  rule is LSD radix sort for integer keys.
- Direction: radix sort in `frameIdOrder`, and a selection or order flag
  update that touches only a selection bit-plane instead of dirtying whole
  slots.

### S8. Economy storm: 350 ms input handlers (placing many buildings)

- s1 #30 / #31 `scn.economyStorm`: frame **357 ms**, handler **348 ms**. Profiled
  (s1 #17, #30):
  - `drawImage` +432 ms and `drawPendingBuildGhosts` (renderer.js:4730)
    +199 ms, a 2D canvas draw of every pending build ghost; also `save` and
    `stroke`;
  - `findNearestOwnedSelectableClickTarget` (main.js:1603) **+342 ms**;
  - `getSceneDepthAtCssPixel` +52 ms; `_areaHasForeignBuildPresence` +46 ms.
  - On the simulation side, `mv_move_occupancy` internals +937 ms.
- Direction: draw the ghosts as one GPU batch, not per-ghost canvas calls.
  Click-target lookup from the frame's spatial bins. Check why the click
  handler runs a nearest-target search on build clicks.

### S9. Combat effects and minimap / camera frames (90-170 ms)

- s0 #10 (combo with a view switch): `_pushCombatRecordFx` (effects3d.js:357)
  **+592 ms**, `_fxDrawnAt` +228 ms, `_fxEventFar` +99 ms, `_fxBeam` +88 ms.
  Cumulative over all page profiles: `_pushCombatRecordFx` self time
  **16.3 s**, and `pageUnitDrawnAt` under it ~1 s. That is a steady
  big-fight cost: per combat record and per frame, a JS lookup of each
  shooter's and target's drawn position.
- `cam.zoom` (s0 #1, reproduced): `_simClientApplyFrame` +69 ms,
  `paintMinimapUnitColumns` (renderer.js:5125) +68 ms, `buildFrameEffects`
  +16 ms; frame 142 ms.
- `cam.minimap` (s1 #1, reproduced): `pageUnitDrawnAt` (sim_frame.js:539)
  **+135 ms**, `paintMinimapUnitColumns` +47 ms; frame 92 ms.
- Direction: build the effects from the combat columns in the presentation
  worker or on the GPU, without a per-record JS position lookup on the page.
  Paint the minimap's unit layer off the page, or only the changed blocks.

### S10. Steady page cost: applying frames

- Cumulative page self time across profiles: `_simClientApplyFrame`
  (sim_client.js:1099) **17.1 s**, `_simClientApplyWorld` (sim_client.js:970)
  **10.2 s + 0.8 s**. This is the largest page cost. Where it rises in a
  trial: s1 #3 (view switch + box + popups) `_simClientApplyWorld` +514 ms; s0 #26
  (boost + orbit + box) `_simClientApplyFrame` +256 ms, `_simClientApplyWorld`
  +113 ms.
- Not analysed further yet. Needs a sub-function breakdown, as with
  `tests/profile-subtree.cjs`, of what applying a frame does per unit on the
  page.

## Other

- Page JS heap rose +6.37 MB/min in session 1. The 14 leak hunts found nothing
  held after GC, so this is likely churn or caches growing with selection size
  (see S5 `keep`).
- `assign_worker`: `assignNearestXY` +438 ms in s0 #8 (big select + rally). It
  runs in a worker, so it is not a page stall, but it delays the order.
- On the simulation thread in several trials: `simParallelCopyHeap`
  (sim_parallel.js:678) about 1.5 s cumulative under `simPresentTickEnd`, and
  0.7 s under `_acqPost`. Those are heap copies at the end of every tick.

## Not covered, or open

- S2 and S3 have no profiles. The two largest combos (s0 #59, #61) were not
  profiled either.
- Tick-trace attribution misses action processing (S1 caveat). Add it to the
  `?simtrace=1` phases before measuring S1/S2 fixes.
- Headless Edge on a machine already at 2-4 TPS: every gap is relative to that
  base. Real headed Edge is needed for spike hunting
  (`defence3-chaos-scene-edge`).
- Repro commands:
  - Whole fuzz: `node tests/perf-fuzz.cjs scenes/chaos-1m-250k.gz --minutes=60 --seed=20261103`.
  - One action against a scene with profiles: perf-fuzz runs the profiled
    repeat on its own when a trial is flagged. `tests/select-all-spike-probe.cjs`
    (S3/S5) and `.claude/scene_tps_probe.cjs` (baseline) exist already.
