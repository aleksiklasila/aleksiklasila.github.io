# High-population tick spikes

Run performance comparisons serially, with no other builds or test runners:

```powershell
node --max-old-space-size=8192 tests/chaos-spikes.bench.cjs --units=1000000 --ticks=240 --helpers=11 --dk=20 --kernels --system-metrics --out=tests/test-runs/chaos-spikes/latest.json
```

The real simulation runs on a 1000-square arena with real shared-memory helpers. The mixed scenario includes every army type, workers, collectors, researchers, builders, salvage, opposing towers, traps, cloud portals, boosts, construction and queued production. Every ten simulation steps both teams issue another command burst, including army orders and rally changes. Initial population is approximately the requested total; integer rounding of each type can change it slightly. Normal deaths and production remain enabled.

The default run takes 240 steps and excludes its first 20 from steady-state statistics. Startup and individual early ticks remain in the output. No forced GC, memory prefaulting or machine cleanup is performed. Rendering and transport are excluded; synthetic player-input generation is outside tick timing, while processing those inputs is inside it.

The event loop yields between steps, as a simulation worker receiving successive messages does. `wallMs` includes that yield and any associated GC delay, so moving a pause between ticks does not hide it. `ms` measures input processing plus `gameTick` itself. `wall`, `steady`, `worst`, `outliers` and all raw rows are saved in JSON; the `.jsonl` sidecar is updated every step. TPS means completed simulation steps per second; `dk` records the base ticks advanced by each step.

Useful options:

- `--warmup=N`, `--ticks=N`, `--units=N`, `--helpers=N`, `--dk=N`, `--burst-every=N` control the workload and measurement window.
- `--kernels` separates foreground kernels, occupancy phases, background waits and index construction mode.
- `--system-metrics` records process CPU, free physical memory, JS heap size and GC time overlapping each measured step.
- `--profile` profiles only the steady window. `--helper-profile` also saves each helper's CPU profile.
- `--no-delta` and `--no-merge` compare index construction strategies; `--no-yield` deliberately stresses an uninterrupted headless loop.
- `DEFENCE_TEST_SOURCE_OVERRIDES` selects historical source/binary snapshots without replacing working files.

Prioritize p99, maximum wall time, slow-step counts and the phases inside those steps. An average improvement alone does not establish that the outliers improved. Keep runs with GC and OS stalls in the results, and repeat comparisons in both orders when assessing small changes.
