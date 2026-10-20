# Movement and memory optimization — 2026-10-20

Continuation of the 4M-unit checkerboard benchmark. Ryzen 7 4800H, 16 GB RAM,
Windows, Node 24.19.0 memory64, seven real helpers, 1000×1000 map. Starts with
4M units and 125,000 opposing mixed towers. Three cold/warmup steps, then
12 measured steps; ordinary deaths leave 3,377,295 → 3,294,687 units in each
comparison window. Every tick includes its actual allocation, GC, waits and
paging stalls. No memory prefaulting, forced collection or machine cleanup.

## Analysis and retained changes

The fresh baseline attributes 249 ms/tick to `simMoveRun`, including its
combat scan and background collision wait. The foreground movement kernel
itself takes 114 ms/tick; all background waits across the tick total 117 ms.
Main-thread CPU sampling identifies `sep_pairs` first, then `mv_move`.
Thus movement arithmetic and waiting for collision work both matter, while
the multi-gigabyte working set competes with the rest of this machine.

1. **Sleeping movement response:** a stationary SIMD group with shallow
   contacts and no flow, closing force or carried displacement keeps its
   contact/brake history, but skips geometric-sum loads and response
   normalization. Nonzero forces, wake-up contacts and path retry work keep
   the full path. Positions, precision and simulation rules are unchanged.
2. **Shared navigation geometry:** profiles with byte-identical wall maps
   and the same cost policy share immutable local fields, graph, components
   and routing atlas. Profile wrappers, versions, sequences and destination
   fields stay independent. Initial builds, asynchronous rebuilds and
   snapshot restores reuse geometry; changing one profile's walls does not
   change another's installed build. This removes **630 MiB of live WASM
   allocation** in the benchmark: 4415 → 3785 MiB. The allocated memory64
   buffer also falls from 5182 → 4606 MiB.
3. **More useful benchmark instrumentation:** separate foreground dispatch
   timings, background wait timing, movement bookkeeping and binding sizes.
   Nested timings are removed from `phaseSelf` to avoid counting them twice.

A trial vectorizing two exact stationary contacts together retained exact
outputs but slowed the contact replay benchmark. It was removed. The
existing four-lane broad phase and movement SIMD remain; reducing precision
was unnecessary for the retained changes.

## Measurements

| Run | Mean tick ms | TPS | Movement dispatch ms | Cold first tick ms |
|---|---:|---:|---:|---:|
| Fresh baseline | 705.5 | 1.42 | 113.6 | 27528 |
| Sleeping response only | 596.5 | 1.68 | 95.3 | 26454 |
| Also shared navigation | 624.9 | 1.60 | 101.8 | 23415 |
| Final repeat | 686.3 | 1.46 | 114.9 | 23299 |

Serial real-machine runs vary substantially. Available RAM ranges were
300–496 MiB in the baseline and 338–680 MiB in the final repeat. The final
repeat's whole tick improves 2.7% (TPS +2.8%); the preceding shared-geometry
run improves 11.4% (TPS +12.9%). The memory reduction and lower cold build
cost are repeatable; these runs do not establish a precise independent
speedup for the sleeping shortcut. The next leading cost remains collision
pair processing and its waits, followed by movement, unit updates and the
spatial index.

## Validation and reproduction

`movement-sleep.test.cjs` replays actual movement chunks through the original
and current kernels, comparing every byte of unit, movement and separation
bindings at dk 1/4/20. Covers quiet contacts, carried brakes/forces, flow and
waking contacts. `nav-shared-build.test.cjs` checks shared geometry,
independent versions, divergent wall maps, immutable snapshots, asynchronous
replacement and restoration of a rebuild in progress.

Both WASM variants rebuilt. General regression results are stored in
`validation.json`; worker-mode results in `worker-validation.json`.
Whole-scene hash differences are not an acceptance gate, per the user.

The broader main-thread selection passes **25/27** files. Two existing
failures (`nav-rows` pool-growth expectation and `separation-rally` sustained
inward-order pressure) have byte-identical output in the 2026-10-19 full
regression results; see `known-failures.json`. They also reproduce with
navigation sharing disabled and, for the rally test, the saved original
movement kernel. Their assertions were preserved.

Additional simulation-worker checks pass **4/4**: adaptive multiplayer,
parallel kernels, collision integration and shared spatial determinism.
The custom baseline-kernel/no-sharing benchmark flags also pass a small
memory64 scene with three real helpers. Total: **29 passing checks**, plus
the two independently confirmed existing failures.

```powershell
& 'C:/Users/aleks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --max-old-space-size=10000 tests/checkerboard-tps.bench.cjs --units=4000000 --map=1000 --helpers=7 --warmup=3 --ticks=12 --profile --out=tests/test-runs/movement-tps-20261020/repeat.json
```

For the start-of-this-pass reference, add
`--wasm64=tests/test-runs/movement-tps-20261020/baseline-wasm64.js --no-nav-sharing`.
The two preserved baseline bundles include the previous pass's pair
optimizations. Raw JSON, per-tick JSONL, CPU profiles and build/test logs
are retained alongside this report.
