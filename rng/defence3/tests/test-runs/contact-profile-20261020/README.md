# Contact chunks, helper waits and memory — 2026-10-20

The contact kernel has substantial compute cost even with a small resident working set. In an actual interior band captured from the 4M checkerboard, roughly 37% of isolated contact samples are in the candidate scan, 35% in stationary SIMD response arithmetic, 18% in per-unit setup/bounds/final accumulation, 5.5% in scattering the stationary response to the other unit, 2.4% in building the row lookup table and 2.3% in the general exact response. These are **exclusive samples in a diagnostic split build**, not hardware instruction or cache-miss measurements.

The phase called a background “wait” mostly runs useful work on the simulation thread. There is also a separate, real index-stage wait. Memory pressure and disk page-ins are present in the full scene, but the measurements do not establish that DRAM bandwidth is the primary limit.

## Full scene

Ryzen 7 4800H, 16 GB RAM, Windows, bundled Node 24.19.0, memory64. Four million starting normal units, 125,000 opposing mixed towers, 1000 × 1000 map, groups of 32 per team, seven real helpers, dk=1, ordinary combat/deaths enabled, three warmups and 24 measured ticks. No rendering, transport, forced GC, prefaulting, memory cleanup or exclusion of stalls. The production run ends at 3,327,946 living units. Runs, builds and isolated timed replays were serial.

The instrumented production run (`production.json`) averages **704.9 ms/tick**, median 662.9 ms, p95 1044.3 ms. This is a diagnostic measurement on the machine as it stood, not a speed comparison against the older report's 528 ms run.

| Main-thread path | Wall ms/tick | Running kernels within it | Blocked in Atomics.wait |
|---|---:|---:|---:|
| Collect separation on index lane 6 | 105.17 | 99.88 (95.56 pairs, 4.32 mark) | 4.79 |
| Collect index / initial zero stage on lane 6 | 72.93 | 35.17 | 35.95 |
| Collect combat tier on lane 2 | 42.45 | 41.70 | 0.11 |

The small differences are orchestration, instrumentation and ordinary JS overhead. These rows are distinct paths. The old coarse `simParallelBackgroundWait` total of 147.62 ms includes the first and third rows; the stage wait lives inside spatial-index rebuild. Do not add these values to inclusive parent phases.

All main-thread Atomics.wait calls total **44.76 ms/tick**: 40.74 ms on control word 58 (lane 6 completion), 3.83 ms on foreground completion, and very little elsewhere. The helper completion loops are `src/sim/sim_parallel.js:1336` and `:1375`; the stage dependency is `src/game/chunk.js:399`, particularly `:408`. It waits through the index and the first separation stage because they read live inputs which the next tick will mutate.

Across all eight threads, pair chunks sum to **1197 thread-ms/tick**, versus 895 for MOVE and 693 for ACQ_SCAN. These are summed elapsed kernel intervals, including preemption/faults, **not measured CPU cycles and not additive tick wall time**. Pair chunks have p50 4.706 ms, p95 7.651 ms and maximum 40.733 ms. The main thread runs 476 of 5750 recorded pair chunks; the seven helpers run 749, 750, 748, 737, 766, 750 and 774. Their aggregate pair elapsed times are also similar (3745–3813 ms each across the window). There is no evidence of one persistently slow helper; long individual scheduling/fault tails remain possible.

The full-scene named-section run (`named-sections.json`) takes 738.1 ms/tick. Its main-thread contact samples split about **37% candidate scan, 22% stationary SIMD response, 22% general exact response and 19% outer per-unit/band work**. Unlike the stationary interior sample below, the whole scene has substantial general response work. This is main-thread sampling, not a separate profile of every helper.

## What one actual chunk does

`captured.json.chunk-6.json` contains interior chunk 71, parity 0, rows 568–571 inclusive, from measured tick 6. The chain supplies H=4 rows per band and reach=2 rows, so the packed input includes an eight-row halo region with **27,311 entries**. Of these, 13,651 belong to the owned rows and 6,905 participate in this sample. Output-slot spacing is retained: original slot IDs 2,272,000–2,303,999 are translated by a common base, not densely reordered.

Counters from `replay-6-counters.json`:

| Operation | Count per chunk |
|---|---:|
| Owned entries visited | 13,651 |
| Participating units | 6,905 |
| Neighbor-row spans visited | 19,550 |
| Four-lane candidate vectors | 67,173 |
| Whole vectors rejected for eligibility | 1,312 |
| Eligible candidate lanes tested geometrically | 169,346 |
| Broad-phase hits | 55,608 |
| Stationary SIMD response calls | 31,630 |
| Contacts handled by stationary SIMD | 54,677 |
| General exact-test calls / accepted contacts | 931 / 918 |
| Total outgoing contacts | 55,595 |
| Units reaching the outgoing budget | 5,190 |
| Stationary updates to the other participant | 15,825 |

Thus this is not a tiny job taking 4.7 ms: it represents thousands of units and tens of thousands of contact responses. There are about 24.5 eligible candidates and 8.05 outgoing contacts per participating unit here. About 75% reach the budget. The budget of 8 counts successful outgoing contacts, not all candidates, and a SIMD batch may go beyond it. Stationary SIMD handles 98.35% of accepted contacts in **this captured band**. Counting whole-vector eligibility rejection shows it is a small fraction here, not the dominant explanation for the scan cost.

## Where inside the chunk

`replay-6-detailed.json` profiles 1200 exact replays of the captured interior band. Names from multiple V8 code tiers are combined before calculating percentages. Resetting outputs and JS/inspector work are excluded from the contact sample denominator.

| Exclusive section | Contact sample share | Current Rust source |
|---|---:|---|
| Candidate scan: metadata, geometry loads, SIMD distance test, selection/iteration | 37.1% | `wasm/src/lib.rs:789`, loop `:800`, geometry `:815` |
| Stationary SIMD geometry/response, rounding and local accumulation | 34.7% | `wasm/src/lib.rs:693`, sqrt `:698`, divisions `:709` |
| Per-unit state/bounds, row lookup, final self accumulation | 18.0% | `wasm/src/lib.rs:936`, bounds `:988`, neighbor loop `:1014`, output `:1030` |
| Scatter stationary results to the other participant | 5.5% | `wasm/src/lib.rs:736` |
| Construct band row lookup table | 2.4% | `wasm/src/lib.rs:753` |
| General exact response | 2.3% | `wasm/src/lib.rs:549` |

These locate hot **source blocks**, not individual-instruction stall percentages. The profiling feature keeps these blocks as separate non-inlined functions; the detailed profile also skips wasm-opt to preserve the sections. This perturbs optimization and call cost, so its 3.39 ms average is not a production-speed result. The normal kernel remains the timing baseline. The outer 18% has not been separated into individual setup/bounds/store percentages.

The SIMD response still executes vector sqrt, two vector divisions, floor/rounding conversions, reductions and participation handling even when velocities are zero. A stationary crowd therefore still has substantial arithmetic cost. The other-side scatter is much smaller than scan plus arithmetic in this resident replay. This identifies response arithmetic and candidate work as the first places to investigate, ahead of tuning the wait polling interval or rebuilding the row table.

## Resident replay versus the full scene

The production kernel replays the interior chunk at **2.902 ms mean / 2.615 ms median**. Thirty-two rotating copies span 59.96 MiB of allocated replay memory and take **3.013 ms mean / 2.682 ms median**. Reversing the order gives **2.934 ms rotating versus 2.915 ms hot** (medians 2.69 / 2.63 ms). There is no large or repeatable cold-copy penalty in this limited experiment.

This is not a bandwidth measurement. It runs on one thread with a small resident scene, retains only the band and halo, resets outputs outside the timed call (warming them), and does not reproduce seven competing helpers or the multi-gigabyte world. The 4.706 ms full-scene median is a distribution of different chunks, not a matched measurement of this same chunk. The difference cannot be assigned numerically to paging, scheduling or bandwidth.

The edge sample `captured.json.chunk-12.json` is much cheaper: only 1,114 owned entries / 181 participants, 5,235 eligible candidates and 1,003 contacts. It replays at **0.122 ms mean**, versus 0.146 ms for rotating copies. Band occupancy and participation plainly matter; a fixed row count is not a fixed amount of work.

The full production measurement reaches **29.5 MiB available RAM**. System-wide Windows memory counters during its 17-second measured window average **209 page-read operations/s and 7,886 pages input/s**, approximately 30.8 MiB/s at 4 KiB/page. These are disk page-ins, but are system-wide and may include file-backed reads from other processes. The benchmark process records **341,892 total faults**; those include soft faults and must not be called disk faults. Live WASM allocations reach 3686 MiB; process RSS and the reserved WASM address space are different quantities.

Memory pressure can therefore contribute to full-scene tails. It does not explain away the multi-millisecond resident arithmetic work. Hardware cache-miss, instruction/cycle and DRAM counters remain unavailable under this user's non-administrator token (the earlier WPR attempts were denied). No claim of DRAM saturation or an exact per-line memory-stall fraction is supported.

## Artifacts, validation and limits

`production.json.trace.json` and `named-sections.json.trace.json` contain all-thread kernel intervals and main-thread waits. Their `*.analysis.json` / `*-summary.json` files hold the decomposition. Original inspector profiles are retained. The first two runs serialized trace data before stopping the inspector; the analyzer excludes the initial inspector-start sample and truncates to the measured window, so post-window JSON/GC is not used as kernel evidence. Current benchmark code stops profiling before serializing traces.

`captured.json` is a capture run, **not a performance comparison**: copying/writing snapshots inside the selected chunks adds overhead. Captures contain packed inputs, original output slot positions and initial sums. Replays crop to the owned band plus its reachable halo, preserve unit IDs and entry order, and keep the same band parameters. They omit the cost of searching the full-world key array and the world's cache/scheduling pressure.

All eight output columns match byte-for-byte for both captures between the production binary, the counter build, the first named build, the detailed split build and a default-feature build of the current source. Tracing on/off at 4,000 units with real helpers gives the same final state hash `e4847207`. Syntax checks pass. No production WASM binary was replaced and no collision rule was changed. New counters are compiled out unless `sepdiag` is enabled; the ordinary build inlines the profiling extraction helpers.

The attempted three-helper full run exhausted the original trace capacity at export; its logs are preserved as `four-threads.*`, but it supplies no accepted scaling comparison. Trace sizing now redistributes the same total capacity by participant count; overflow is explicitly marked and rejected by analysis, without discarding the benchmark result.

## Reproduce

Use the bundled Node 24 executable, not an older Node lacking standard memory64.

```powershell
./tests/profile-checkerboard-contacts.ps1 -Name production-repeat
./tests/profile-checkerboard-contacts.ps1 -Name capture-repeat -Ticks 12 -Capture
node tests/analyze-contact-trace.cjs tests/test-runs/contact-profile-20261020/production.json

node wasm/build.cjs --wasm64 --features=prof --keep-names --no-wasm-opt --target-dir=target-contact-prof --out=tests/test-runs/contact-profile-20261020/detailed-wasm64.js
node wasm/build.cjs --wasm64 --features=sepdiag --keep-names --target-dir=target-contact-prof --out=tests/test-runs/contact-profile-20261020/counters-wasm64.js

node tests/replay-contact-chunk.cjs tests/test-runs/contact-profile-20261020/captured.json.chunk-6.json --iterations=600
# Add --copies=32 to rotate resident copies.
# Add --profile --kernel=.../detailed-wasm64.js for source-section samples.
# Add --counters --kernel=.../counters-wasm64.js for operation counts.
# Add --oracle=.../replay-6-hot.json to assert identical outputs.
```

Run measured jobs serially. The PowerShell sampler needs access to Windows CIM memory counters; an ordinary terminal outside the restricted tool sandbox provided that access here.
