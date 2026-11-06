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

## Hard rule: wasm, no JS fallbacks

- Convert simulation JS to wasm directly and completely (kernels on helpers / lanes / preparation). Not a JS rewrite first, not JS glue doing per-item work.
- No fallbacks: never keep or add a JS path for cases a kernel cannot do. If state the kernel needs is still JS (objects, arrays, tables), move it to the wasm heap and the logic to wasm in the same change. Kernels never hand items back to JS for per-item handling.
- No temporary JS or detours: no interim step where JS makes rows / entries / keys for a kernel. Static and derived tables (stats as [type][level][stat][researchLevel], costs, lookups) are built whole in the wasm heap at match start or at their change event. Tables of ~1 MB are fine.
- Exceptions only when wasm is impossible (DOM, network, page UI) or measurably costs significant performance; say so explicitly.
- Match functionality, not the old JS structure: simplify while converting.
- The main tick thread only applies (O(1) / O(things changed)); no arbitrary per-tick budgets or count caps.
