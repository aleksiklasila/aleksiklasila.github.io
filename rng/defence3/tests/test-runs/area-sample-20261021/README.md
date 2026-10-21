# Area-based acquisition experiment — 2026-10-21

## Current experiment: area-only eligibility, guaranteed lookup

Area-only search and occupancy are now enabled by default. `?acq=exact`
and `?occupancy=0` retain the comparison paths; the benchmark uses
`--exact-targets` and `--no-occupancy`. The page forwards these settings
to its authority and shadow simulation workers. Historical measurements
below retain the explicit modes recorded in their JSON files.

Units are packed by area and owner from the acquisition snapshot. A
multi-source breadth-first pass builds, per viewer and source area, an
answer pointing to a nonempty visible enemy area and its graph distance.
Queries check the existing source window (up to four areas), compare graph
distance with the ceiling of vision range in area units, and choose the
best of one deterministic four-unit batch in the selected enemy area.
Pixel distance ranks that batch but NEVER rejects a target.

Structures use the same area-only eligibility. Separate answer tables
preserve turret/trap/barrack/other priority. A lookup succeeds on its first
attempt whenever an eligible enemy exists in that snapshot; there is no
random miss and no 64-area neighbourhood cap in this mode.

The lookup is constant-time per unit. Maintaining the packed snapshot and
answer tables is linear in units, areas and graph edges, and is included
in the whole-simulation measurements. Tables update on the existing
acquisition tier; this does not remove the tier's existing tick cadence or
snapshot-to-commit delay. Targets dying after the snapshot can still fail
the existing live identity/death checks.

## Correctness

`quality-area64.json` uses an independent forward BFS of every query's
source window, not the Rust precomputed answer tables. Dense, frontline,
sparse and visibility fixtures all have 100% first-attempt unit coverage.
Every eligible structure is found too, with the correct priority class.

An explicit boundary fixture places a unit and a structure outside the old
pixel circle but inside an eligible neighbouring area; both must be found.
Serial and seven-helper runs match every tick over 4,200 active units,
including a mid-run snapshot restore (`determinism-area.log`). The local
URL setting reaches the real simulation worker (`worker-area-start.log`).

## 1M starting-unit production runs

Node 24.19.0, Ryzen 7 4800H, map 512, seven real helpers, packed layout,
occupancy, six warmup ticks and 48 measured ticks. Runs are sequential;
rendering/transport are absent. No compiler or other benchmark runs at the
same time. Index maintenance and normal gameplay are included.

| Mode | Runs | Mean ms/tick | TPS | Surviving units at tick 54 |
|---|---:|---:|---:|---:|
| Exact, current-binary control | 1 | 108.725 | 9.198 | 590,992 |
| Area-only, first | 1 | 92.832 | 10.772 | 663,161 |
| Area-only, repeat | 1 | 91.379 | 10.943 | 663,161 |

The pooled area-only mean is 92.106 ms/tick (10.857 TPS), about 18% higher
TPS than the current-binary control. The repeated area runs produce the
same final hash `2660179e`; exact produces `4b92a274`. Different target
choices and range eligibility change battle outcomes, so this is NOT an
identical-work kernel speedup. First measured live heap: approximately
874 MiB exact versus 910 MiB area-only.

## Earlier, superseded geometric sample experiment

The initial `--acq-samples=4|16|64` experiments still applied a pixel-radius
cutoff after sampling. Their 83% frontline coverage was caused by that
filter, NOT missing membership in area lists. Those results do not describe
the area-only mode. The geometric versions and their logs remain for
comparison, including `geometric-sample64.js` and `quality-geometric64.json`.

Geometric sample results: pooled exact 8.990 TPS, four candidates 10.547 TPS,
16 candidates 9.572 TPS, 64 candidates 8.553 TPS. Four candidates found
82.8% of available frontline targets in one attempt and 94.6% over four
resamples. That retry behavior is deliberately absent from area-only mode.

## Reproduce

```
node --max-old-space-size=8000 tests/checkerboard-tps.bench.cjs --units=1000000 --map=512 --ticks=48 --warmup=6 --helpers=7 --occupancy --packed --area-targets --out=tests/test-runs/area-sample-20261021/area-new.json
node tests/area-acquisition-sample.bench.cjs --area-targets --out=tests/test-runs/area-sample-20261021/quality-area-new.json
pwsh -File tests/run-area-memory.ps1 -Mode Compare -Ticks 24 -Warmup 6
```

The last command runs the 4M exact and area-only cases sequentially on map
1024, with Windows available-memory and paging counters. Its results are
recorded separately below once the comparison completes.

## 4M starting-unit results

Map 1024, seven real helpers, packed occupancy layout, six warmups and 24
measured ticks. All runs use the same production WASM hash. Windows paging
counters are sampled during each run; the figures below include only the
measurement window.

| Mode | Mean ms/tick | TPS | P50 ms | Average page reads/s | Available MiB | Final live units |
|---|---:|---:|---:|---:|---:|---:|
| Exact, first | 340.412 | 2.938 | 267.300 | 815.5 | 165–601 | 3,878,343 |
| Area-only | 270.383 | 3.698 | 229.736 | 55.2 | 689–990 | 3,452,871 |
| Exact, repeat after area | 298.695 | 3.348 | 206.116 | 2.3 | 796–1,018 | 3,878,343 |

Area-only is about 10.5% faster than the low-paging exact repeat by mean
tick time/TPS. The first comparison's apparent 26% gain is confounded by
heavy paging. Median tick time does not improve against the exact repeat.
Area-only also has fewer surviving units already at the first measured
tick (3,459,210 versus 3,895,474). These are different gameplay workloads,
so the figures do not establish a pure kernel speedup at 4M.

Both exact controls use WASM hash `f624ce25420e3efc` and end with the same
unit/tower counts, but their unit-state hashes differ (`49cf5ab6` versus
`1f5f5773`); all other subsystem hashes agree. Their full hashes are
`f4f086c1` and `1bcf9c90`. This is an unresolved large-run repeatability
issue in the exact controls and limits conclusions from the 4M timing.
It has not been attributed to a specific kernel. The area-only 4M final
hash is `4dd03817`. Occupancy audits pass in all three runs.

No compiler or other benchmark was running during these measurements.
The saved 4M binaries precede a later portability fix to unsigned owner
rotation; the build logs identify the corresponding generated versions.
