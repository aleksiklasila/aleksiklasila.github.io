# Simulation throughput architecture

## Goal and measurement

Target 100,000 concurrently active units, tens of thousands of buildings and
maps up to 1,000 by 1,000. The acceptance target is 10–20 times baseline tick
throughput, not an idle-world or render-only speedup. This is a target, not a
measured result. Preserve immediate command admission and move feedback; do not
hide expensive simulation behind a growing queue.

Checkpoint `99a1e51` on Ryzen 7 4800H, Node harness, 100,000 units / 2,806
buildings / 200² map, four attack-move groups per owner, 7 real helper workers:
40 measured ticks after 20 warmup ticks, mean tick 857 ms, median 783 ms,
p95 1,495 ms; mean separation 139 ms; frame publication 125 ms separately.
Command processing is included. Short horizon; this is movement onset, not a
claim about sustained combat. Main-thread sampling identifies spatial updates,
unit updates, steering, stat passes and separation preparation as major costs.
Helpers are not represented in that CPU profile.

Measure movement onset, sustained movement, dense contact combat, dispersed
combat, worker/building activity, and topology changes separately. Record actual
moving/attacking/working populations, command-to-first-motion delay, tick p50 /
p95 / p99, publication cost, memory, and helper work distribution. Run hardware
scaling at 0 / 1 / 3 / 7 / 11 / 15 helpers where available, serially to avoid
benchmark contention. Keep deterministic hashes with every result. Test 20k,
50k and 100k units and 200² / 500² / 1,000² maps; isolate map memory costs.

## Execution order

1. **Reliable active-workload measurement and correctness gates.** Add subsystem
   timing and population counters to the scale harness. Diagnose existing worker
   regression timeouts rather than counting them as passes. Keep checkpoint
   baselines fixed by commit, not a moving HEAD. Timing instrumentation is opt-in.
2. **Shared spatial architecture.** Replace object traversal in hot neighbourhood
   kernels with reusable typed columns and contiguous cell ranges. Build one
   spatial snapshot per simulation phase and reuse it for collision, perception,
   density and stat queries. Parallelize classification, histogram and scattering
   with disjoint worker outputs and deterministic prefix reductions. Avoid a
   sorted-array insertion/removal for every moving unit. Keep a migration adapter
   for existing queries until they have explicit phase semantics.
3. **Navigation per destination/group, not per unit.** The current reverse group
   search already shares search work but expands routes into per-start arrays.
   Retain immutable shared distance/direction fields keyed by destination,
   movement profile, owner/portal permissions and topology generation. A unit
   stores a field handle and local steering state. O(1) normal next-step lookup;
   amortized search per field; parallel independent fields. Bound memory and work
   by deterministic budgets, reuse fields across ticks and handle invalidation,
   unreachable goals, portals and clearance explicitly. Keep precise local
   routing for exceptional transitions. Clicks enter the next simulation tick;
   expensive field completion must not stall every unit.
4. **Parallel active-unit phases.** Replace sequential `Unit.update()` with
   explicit read/compute/commit phases: statuses and commands; perception;
   steering; collision; combat/worker intents; deterministic interaction commit.
   Helpers read immutable phase inputs and write per-slot outputs. Cold object
   adapters belong at boundaries, not in every unit's arithmetic. Migrate hot
   timers, flags, target handles and stat references into typed columns. Share
   immutable stat tables by owner/type/level instead of cloning them per unit.
   Partition work into small dynamically claimed chunks, including within dense
   cells. Prioritize moving and fighting units, not sleeping idle units.
5. **Batched interactions and searches.** Batch queries by cell/owner/range and
   worker task class. Maintain indexed resource/building/damaged-target sets.
   Share broad-phase results, retaining exact narrow-phase checks and stable
   tie-breaks. Replace full-grid per-type stat prefix rebuilds with reusable
   dirty spatial aggregates. Use bounded top-k selection instead of sorting all
   candidates. Avoid U×B or U×U scans, especially under dense contention.
6. **Publication and pipelining.** Publish immutable shared render columns at a
   bounded cadence independent of simulation catch-up. Interpolate visually;
   do not skip gameplay ticks. Overlap independent jobs within a tick, then
   consider deterministic one-tick pipelines only for decisions whose response
   budget permits it. Commands and local motion feedback retain priority.

## Determinism and phase contract

Changing phase semantics is an intentional simulation revision, not a promise
of identical trajectories to the old sequential engine. First preserve exact
legacy results for pure kernels; for phase changes verify the new serial
reference against every helper count, scheduling order and snapshot restore.
No outcome may depend on wall-clock deadlines, worker availability, claim order,
atomic floating-point accumulation or local selection/render state. Commit
damage, resource spending, spawn/death, locks and topology changes in a defined
stable order. Use fixed-order reductions or exact integer accumulators.

Snapshot/load, partial repair, replay, joins, ownership changes, slot reuse,
worker failure and non-isolated fallback are correctness requirements. Shared
buffers have explicit ownership and generation lifetimes. Benchmark end-to-end
cost including packing, joins, commit and publication, not just kernel time.

## Performance gates and hardware

After each major migration: oracle/property tests for the affected algorithm;
real-thread equivalence; active workload before/after and scaling; multiplayer
determinism/repair and full regression checks. Reject regressions on smaller
worlds; select serial execution below measured batching thresholds. Report
total TPS improvement separately from subsystem speedup.

CPU shared-memory execution is the first path. A deterministic browser GPU
simulation would require fixed-point kernels, portable integer behavior and
readback/synchronization measurement. GPU render work and visual particles are
independent; do not move authoritative floating-point combat there speculatively.
Removing serial object passes and redundant work comes before claiming scaling
on 12–32 hardware threads. Amdahl's law requires less than 5–10% of the original
serial cost for the requested uplift, even with many workers.

## First execution checkpoint

Implemented a reusable stable shared radix index (partition histograms,
fixed-order prefix reduction, parallel scatter), parallel collision snapshot
preparation and parallel within-tile correction. Swept wall/portal/special
movement remains the exact serial fallback. This is part of step 2; the general
spatial index and unit update phase migration are still outstanding. No contact
counts are capped and no gameplay ticks or active units are skipped.

The pool no longer has an absolute seven-helper ceiling. Automatic sizing
retains seven on this 16-thread CPU and increases on larger CPUs; `simhelpers`
can explicitly use additional hardware threads, leaving two for other work.

Paired measurements, `node tests/active-scale.bench.cjs`, one run per setting,
same machine and fixed checkpoint. Times include commands/setup within the
measured command tick; frame publication is measured separately. Raw results:
`tests/active-scale-results.json`. These are Node harness results, not browser
FPS or a prediction of portable hardware scaling.

| Workload | Checkpoint, 7 helpers | Current, 0 | Current, 7 | Current, 11 |
|---|---:|---:|---:|---:|
| 100k movement, mean tick ms | 849.2 | 846.3 | 800.6 | 810.1 |
| 100k movement, median tick ms | 788.7 | 797.1 | 724.6 | 728.3 |
| 100k movement, mean separation ms | 142.0 | 157.3 | 89.1 | 91.9 |
| 20k combat, mean tick ms | 201.2 | 195.2 | 187.0 | 199.1 |
| 20k combat, mean separation ms | 16.4 | 15.7 | 10.4 | 11.1 |

At tick 60 the movement test has 82,205 moving units and 1,351 working units.
The combat test starts with 15,914 attacking units, continues through deaths
and still has 13,322 attacking at tick 80. Both workloads retain identical fast
and exact fingerprints and activity counts for every helper setting and the
checkpoint. Seven helpers are faster than eleven here; increasing thread count
alone does not solve the serial bottleneck.

The measured overall improvement is approximately 1.06× for movement and 1.08×
for combat, despite approximately 1.6× separation improvement. **The 10–20× TPS
goal is not achieved.** Next priority remains migrating steering, perception and
spatial maintenance out of the serial object loop, followed by shared group
navigation fields and batched interaction commits, rather than further tuning
this collision kernel.
