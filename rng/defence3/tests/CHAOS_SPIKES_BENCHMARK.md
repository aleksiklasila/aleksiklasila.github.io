# High-population tick spikes

Run performance comparisons serially, with no other builds or test runners:

```powershell
node --max-old-space-size=8192 tests/chaos-spikes.bench.cjs --units=1000000 --structures=250000 --ticks=240 --helpers=11 --dk=1 --kernels --system-metrics --out=tests/test-runs/chaos-spikes/latest.json
```

The real simulation runs on a 1000-square arena with real shared-memory helpers. The default starts at about one million units and at least 250,000 structures, including all army/barrack/turret types, farms, mines, worker buildings, traps and sixteen cloud portal endpoints. Every worker profession starts with at least 30,000 units total. Collector farms surround drop-off buildings; research, production/healer, construction and salvage districts supply nearby jobs. Staggered solid turret runs and alternating-owner checkerboards create choke points. Research levels span seeded R0–R10; boosts and recurring player orders exercise changing stats, construction, rally points, queues, targeted attacks and movement.

The line fixture's original capacity silently left most large armies at base. The dense generator now positions and orders the remainder too. Worker placement establishes normal exclusive reservations; oversupply exercises no-work searches. `activity.roles` distinguishes targeted, carrying, transfer-cooldown and idle workers. `work` counts successful research/collector transfers, births, completions and destroyed structures. Assignment alone does not prove useful work. Population caps are recorded alongside counts.

Initial population is approximate because of integer rounding. Deaths and normal paid production remain enabled: a large initial population is **not** a promise that the measured window remains at one million. Report `population.min/max`, births/deaths and actual work with every timing. Adaptive `dk=20` advances twenty base ticks per sample and can thin armies heavily; compare it separately from `dk=1` or `dk=4`. No units are silently replenished outside timing.

`--layout=front` adds facing barracks/healer rows with gaps, sparse turret support and cross-front rally points. Most starting reserve units travel behind the lines while paid queues feed the front; mixed workers continue behind it. Birth/death counters reveal whether production actually keeps up. This is a secondary workload; use the fully mixed layout first when optimizing.

The default run takes 240 steps and excludes its first 20 from steady-state statistics. Startup and individual early ticks remain in the output. No forced GC, memory prefaulting or machine cleanup is performed. Rendering and transport are excluded; synthetic player-input generation is outside tick timing, while processing those inputs is inside it.

The event loop yields between steps, as a simulation worker receiving successive messages does. `wallMs` includes that yield and any associated GC delay, so moving a pause between ticks does not hide it. `ms` measures input processing plus `gameTick` itself. `wall`, `steady`, `worst`, `outliers` and all raw rows are saved in JSON; the `.jsonl` sidecar is updated every step. TPS means completed simulation steps per second; `dk` records the base ticks advanced by each step.

Useful options:

- `--warmup=N`, `--ticks=N`, `--units=N`, `--helpers=N`, `--dk=N`, `--burst-every=N` control the workload and measurement window.
- `--structures=N` controls the dense structural target (default 250000); `--worker-min=N` sets each profession's total minimum (default 30000). The generator fails if the target does not fit. `--unit-level-offset=N` raises normal starting unit levels (default 8 in the dense workload). `--structures=0 --worker-min=0 --unit-level-offset=0 --dk=20` retains the older sparse structural fixture.
- `--tower-mode=js` measures scalar turret searches; `auto` uses the batched SoA/WASM SIMD kernel when available, and `verify` additionally compares every batched answer against the scalar live query. Verification timing includes both paths and is diagnostic.
- `--kernels` separates foreground kernels, occupancy phases, background waits and index construction mode.
- `--system-metrics` records process CPU, free physical memory, JS heap size and GC time overlapping each measured step.
- `--profile` profiles only the steady window. `--helper-profile` also saves each helper's CPU profile. `--profile-interval=5000` sets the sampling interval in microseconds (the default); use a longer interval to limit profiling overhead on large matches.
- `--profile-start=300` delays CPU profiling until step 300 to investigate late-game outliers without accumulating a whole run's profiling overhead. The analyzer selects its worst step from the captured window.
- `--timeline` records phase intervals for profile slicing with `--phase=kernel:8`, `--phase=kernel:89:0` or `--phase=simMoveRun` in the analyzer.
- `--allocation-profile` samples JavaScript allocations during the steady window, including objects later collected, into a `.heapprofile` sidecar. Use this diagnostic separately from unprofiled timing comparisons.
- `--event-metrics` counts event codes, worker AI states/transitions, budget deferrals and fast route commits per tick. It adds per-event wrapper overhead; use it for attribution separately from acceptance timings.
- `--no-delta` and `--no-merge` compare index construction strategies; `--no-yield` deliberately stresses an uninterrupted headless loop.
- `DEFENCE_TEST_SOURCE_OVERRIDES` selects historical source/binary snapshots without replacing working files.

Prioritize p99, maximum wall time, slow-step counts and the phases inside those steps. An average improvement alone does not establish that the outliers improved. Keep runs with GC and OS stalls in the results, and repeat comparisons in both orders when assessing small changes.

Slice all captured threads around the slowest steady step and a nearby step with the same command-burst status:

```powershell
node tests/chaos-spike-profile.cjs tests/test-runs/chaos-spikes/latest.json
```

Use `--step=N` and `--reference=N` to inspect another pair. The analyzer writes a `.spike-analysis.json` sidecar and includes the immediately **previous and next tick**, with phase timings and sampled attribution for every captured thread. Always inspect that neighborhood when hunting gameplay spikes: determine which phase expands only on the slow tick, whether work spills into adjacent ticks, and whether GC or scheduling contributes. Compare against a nearby normal tick with the same action-burst status as well. Browser matches have the existing `?simtrace=1` per-tick phase trace in `window.__simTrace`.

Sampled thread times are aggregated across concurrent threads and are not elapsed tick time; use the recorded phases and process CPU metrics alongside them. Profiling every helper changes timing and memory use, so establish tail latency with an unprofiled run as well. Loading/setup happens before the timed loop; warmup statistics and individual early gameplay ticks are retained separately rather than silently discarded.

When WASM samples only show numeric function names, make a separate diagnostic binary with `node wasm/build.cjs --wasm32 --features=prof --keep-names --target-dir=target-chaos-profile --out=tests/test-runs/named-wasm32.js` and select it through `DEFENCE_TEST_SOURCE_OVERRIDES` for `src/sim/sim_wasm_bin.js`. For memory64, use `--wasm64` and override `src/sim/sim_wasm64_bin.js` instead. Keep these profiling binaries separate from production; use regular builds for final latency comparisons. `--helper-profile --timeline --kernels` captures the helper threads and phase boundaries needed for full attribution. After changing Rust, rebuild both production variants with `node wasm/build.cjs`.

Summarize sampled allocations with `node tests/chaos-allocation-profile.cjs tests/test-runs/chaos-spikes/latest.json`. Its sidecar separates simulation allocations from synthetic command generation. Both can cause later GC; only simulation allocation reductions are production optimizations.

The serial matrix includes mixed chaos at dk=1/4/20, production fronts at dk=1/20, and the original million-unit combat checkerboard at dk=1/20:

```powershell
node tests/chaos-tps-matrix.bench.cjs --scenarios=chaos-dk1,chaos-dk20 --compare-towers --repeats=2 --ticks=140 --warmup=20 --hash --out=tests/test-runs/tower-comparison
```

Comparisons alternate order on repeated runs. `--hash` records legacy state hashes as diagnostics; `--require-match` explicitly makes matching a gate. Correct intended behavior and determinism of the retained implementation are required; historical bit identity is optional. `--reference-dir=DIR` compares saved `baseline-worker.js`, `baseline-projectile.js`, `baseline-tower.js` and `baseline-chunk.js` instead of selecting turret modes. Profiling and timing runs are separate.
