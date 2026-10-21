# TPS kernel optimization, 2026-10-21

Changes: a pair-sized stationary combat path for two-slot occupancy spans;
nearby target seeding before the packed acquisition row scan; SIMD rejection
of friendly, absent and lower-priority structure candidates, plus rejection
of structure rows outside the strict circular range.

Both production WASM32 and WASM64 binaries were regenerated. Existing staged
changes were preserved. No spatial-index granularity or area semantics changed.

## Production measurements

Node 24.19.0, Ryzen 7 4800H, 1,000,000 starting units, 512-tile map,
seven real helper threads, packed layout and occupancy enabled. No rendering.
Runs were serial. Use the checkerboard benchmark with `--units=1000000
--map=512 --helpers=7 --occupancy --packed`. Baseline uses the saved
`baseline64.js`; the final run uses the regenerated production binary.

| Production run | Measured ticks | Warmup | Mean ms | TPS | Final hash |
|---|---:|---:|---:|---:|---|
| Baseline, short | 24 | 6 | 72.081 | 13.873 | 6da14e6a |
| Pair + seed, short | 24 | 6 | 71.855 | 13.917 | 6da14e6a |
| Baseline, long | 120 | 8 | 106.810 | 9.362 | e5c14c68 |
| Final, including structure filters | 120 | 8 | 106.566 | 9.384 | e5c14c68 |

These whole-simulation timings are effectively tied. There is no established
production TPS improvement. The long runs end with the same 263,035 units
and 29,830 towers. Timing conclusions from the earlier profiling builds
(roughly 8% TPS improvement averaged over repeats) did not reproduce as a
material production improvement and must not be treated as the final result.

## Isolated evidence

`acquisition-production-replay.log` compares the actual saved and final
production binaries on an identical 4,096-unit snapshot, with mixed unit and
structure queries. Four paired trials per variant, 20 scans per trial:
baseline mean 270.311 ms, final mean 237.919 ms, about 12% less scan time.

The replay also compares every output against baseline for 12 deterministic
dense/sparse snapshots with visibility differences, short ranges, exact ties,
dead units, all structure priorities, friendly structures and absent owners.
A subset is checked against independent brute-force unit and structure oracles.

`final-hold-replay.json` compares the old SIMD hold path and the pair path in
the same profiling module on four million slots. The pair path uses less CPU;
this isolated/profiling result is not a production TPS measurement. Before
timing, 24 fixtures compare every touched column and adjacent guard lanes,
including invalid targets, partial pairs, NaN energy, changed velocities,
firing timers, cooldown carry, shot counts and hit-list order.

## Area-index follow-up

`forEachUnitInAreaRange` currently enumerates `gridCellsByArea`, then each
tile's unit slice. A direct area-to-unit CSR index could remove those tile
lookups, particularly for `areaOnly` queries. It would add another slot index
and index-maintenance work. Keep the fine occupancy grid; benchmark a separate
area index before using it for Euclidean nearest-target acquisition. The
earlier larger-square-cell experiment is not a test of an area-graph index.
