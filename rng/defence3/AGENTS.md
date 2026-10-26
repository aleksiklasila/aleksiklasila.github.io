# Simulation performance work

For TPS optimization, prioritize **spikes during gameplay**, then normal tick
cost. Loading/setup time before play is a separate concern. A better average
does not establish that multiplayer hitches improved.

Use the existing per-tick traces and CPU-profile slicing technique: inspect
the **previous, slow, and next tick**, plus a nearby normal tick with the same
player-action burst status. Compare phase timings and profiles across the
simulation thread and its helpers. This distinguishes a phase that expands
on the slow tick from work that is expensive every tick, GC, and scheduling
delays. The commands and caveats are in
[`tests/CHAOS_SPIKES_BENCHMARK.md`](tests/CHAOS_SPIKES_BENCHMARK.md).
`tests/chaos-spike-profile.cjs` writes neighboring-tick attribution alongside
the slow/reference comparison. Browser matches also expose per-tick phase
data through `?simtrace=1` and `window.__simTrace`.

Run timing comparisons serially, without competing builds/test runners.
Retain raw tick data, p95/p99/max, slow-tick counts, actual measured population
and worker throughput. Start with the large mixed chaos workload; use other
scenarios to check specific costs and regressions.

The optimized implementation must be deterministic across peers and helper
counts and retain intended behavior. Historical bit-for-bit equality is an
optional diagnostic, not a requirement that blocks changes to numerical
precision or deterministic ordering. Prefer measured WASM/SIMD and SoA
improvements when they reduce the actual gameplay bottleneck.

Record changes, measurements and remaining bottlenecks in
[`OPTIMIZATION_PROGRESS.md`](OPTIMIZATION_PROGRESS.md).
