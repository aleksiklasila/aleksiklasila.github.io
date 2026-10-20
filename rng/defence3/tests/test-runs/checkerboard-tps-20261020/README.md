# 4M checkerboard TPS optimization — 2026-10-20

Real `gameTick()` on the simulation's main thread with seven real shared-memory helpers. No rendering or network transport. Ryzen 7 4800H, 16 GB RAM, Windows, Node 24.19.0 with memory64. Runs were serial, on the machine as it stood: no memory prefaulting, forced GC, background-app cleanup, paging adjustment, or subtraction of allocation/GC/paging stalls from tick times.

## Workload and measurements

1000×1000 map, initially 4,000,000 normal units and 125,000 completed towers. Each block contains two opposing 32-unit groups and two opposing towers; pistol, SMG, sniper, water and poison towers alternate. Ordinary combat and deaths remain enabled. Three warmup ticks precede the comparison window. In every comparison window the population runs from 3,377,295 to 3,294,687 units. Setup and cold ticks are separate costs; recorded TPS is uncapped tick throughput, not a claim that the battle holds 4M living units throughout.

| Run | Mean tick, ms | TPS | p95, ms |
|---|---:|---:|---:|
| Reference storage, original pair kernel, strided cleanup | 821.5 | 1.22 | 2109.9 |
| Reference repeat | 808.1 | 1.24 | 1299.9 |
| Paged IDs, smaller scratch pools, early pair rejection | 694.6 | 1.44 | 1212.1 |
| Also contiguous cleanup blocks | 628.3 | 1.59 | 1043.3 |
| Contiguous cleanup repeat | 693.7 | 1.44 | 1120.0 |
| Stationary pair fast path and smaller candidate/retire lists | 682.2 | 1.47 | 1168.5 |
| Final, including adaptive cleanup cursor fix | 693.4 | 1.44 | 1100.0 |

Rows use the same first 12 measured ticks. The stationary-path run additionally records four more ticks: all 16 average 659.7 ms / 1.52 TPS, with a declining population. Final vs first reference: **15.6% less tick time / 18.5% higher TPS**. Repeat variation is substantial and part of the result. Available RAM during the first reference window was 573–978 MiB; during its repeat, 188–425 MiB; during the final comparison window, 309–626 MiB. The benchmark records RSS, JS heap, WASM allocation and available RAM each tick; it does not infer page-fault counts from these.

The cold serial diagnostic (`checkerboard-4m-serial.json`) recorded 47.3 seconds for the first tick and 4.45 / 3.82 seconds for the next two. The first successful helper-enabled cold run (`checkerboard-4m-transport.json`) recorded 26.9 seconds for its first tick. Scene creation itself took approximately 45–51 seconds. Cold runs include initial navigation and stats work and are not the warmed comparison above.

## Changes and profile findings

* Memory64 helper scratch/argument addresses retain their full Number values instead of signed 32-bit truncation.
* Heap bindings travel as element type, full byte address and length, reconstructed over the already-shared WebAssembly.Memory. This avoids the observed typed-view offset truncation/drop during structured cloning above 4 GiB. Initial bindings publish in one batch, and background claims revalidate the registry version inside the protected claim section.
* `UnitIdIndex` uses small reference pages, releases empty pages, and caches the most recent page. Isolated 4M-entry storage measurements: Map 117.4 MB versus paged 32.5 MB; construction 1170 ms versus 123 ms; sequential lookup 457 ms versus 36 ms (Node 24, same realm, fresh processes).
* Large scratch pools keep 3.125% spare capacity instead of 12.5%; update-candidate and retirement lists use that policy instead of doubling. At the last equivalent measured tick, live WASM allocation fell from 4498 to 4415 MiB. ID storage saves approximately another 81 MiB independently.
* Dead-unit collection walks contiguous 1024-slot blocks. Measured collection phase: 105–166 ms/tick in reference runs, versus approximately 45–57 ms in optimized runs (52.5 ms in the final run). This reduces scattered column reads while detaching dead units. Its cursor advances once per simulation step: using base `gameTime % 64` skipped most slices forever at adaptive `dk=4/20`, retaining dead units and worker/path records. Every slot is now visited within 64 simulation steps at every step size; regression coverage includes dk 1/4/20.
* Pair separation rejects whole SIMD vectors of duplicate/other-layer contacts before loading geometry. Stationary contacts bypass closing-velocity and flow calculations. The stationary microbenchmark improved about 4–9%; whole-tick variation is too large to attribute a separate TPS percentage to this small final change.

Remaining leading cost is movement/separation (roughly 200–240 ms exclusive of the nested combat scan), followed by the unit update pass, spatial-index collection, and dead-unit collection. Main-thread CPU samples still prominently identify `sep_pairs`, `mv_move`, helper-stage waits and detached-value construction. Coarse phase times are wall times and include waits; `phaseSelf` removes nested instrumented phases so `combatScanRun` is not counted twice inside `simMoveRun`.

## Reproduce

Use Node 24+ with memory64; Node 22 cannot fit this workload's working buffers in its wasm32 heap. The bundled runtime used here is `C:/Users/aleks/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`.

```powershell
node --max-old-space-size=10000 tests/checkerboard-tps.bench.cjs --units=4000000 --map=1000 --helpers=7 --warmup=3 --ticks=12 --profile --out=tests/test-runs/checkerboard-tps/repeat.json
```

Optional `--reference-storage --reference-collect --reference-kernel` replays the original storage policy, cleanup policy and preserved memory64 kernel. Helper transport fixes remain enabled so the reference can run at all. `--warmup=0` includes the cold first tick, `--helpers=0` measures serial execution, and `--dk=N` selects a larger simulation step. Group size is adjustable with `--group=N`.

```powershell
node --expose-gc tests/unit-id-index.bench.cjs map
node --expose-gc tests/unit-id-index.bench.cjs paged
node tests/separation-kernel-replay.test.cjs --bench
```

The ID microbenchmark deliberately uses explicit GC to isolate retained lookup storage. The full-scene TPS benchmark does not.

## Validation

Both wasm32 and memory64 binaries rebuilt. Final general regression run: **15/15 pass**, including multiplayer chaos determinism, perturbed-math cross-engine replay, snapshot/slot reuse, shared spatial determinism, adaptive tick multiplayer, collision integration, ABI checks and new transport/lookup/cleanup regressions (`checkerboard-validation-final.json`). Additional worker-mode checks: **4/4 pass** (`checkerboard-worker-validation.json`). The actual Node 24 transport test also passes for every heap element type above 2 and 4 GiB.

Direct original-vs-optimized pair-kernel replays match contact outputs, including stationary contacts, participation/layer differences, SIMD tails, NaNs and coincident positions. Whole-scene hash differences were recorded but are not an acceptance gate, per the user's instruction; general tests are the correctness bar for this TPS work.

Raw JSON, per-tick JSONL, CPU profiles, and logs for intermediate and final runs are retained here. Historical logs contain their original fixture paths and version strings.
