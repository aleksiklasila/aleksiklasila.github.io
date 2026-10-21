# Crowd flow — 2026-10-21

The shared routing atlas directed broad groups through representative portal
tiles. Short look-ahead and repeated lateral recentering concentrated those
groups into thin queues. Exclusive occupation then stopped followers instead
of allowing those queues to overlap.

Implemented:

- A summed table of occupied 8×8 navigation blocks certifies clear rectangles
  with four reads. Units in a certified clear region travel directly toward
  their destination, bypassing artificial portal funnels. The table belongs
  to shared immutable atlas geometry and adds about 63 KiB per distinct
  geometry on a 1000×1000 map. It is prepared when the atlas build finishes.
- Elsewhere, shared route look-ahead extends to 32 steps and pulls the route
  straight only when its entire shortcut segment is walkable. Failed segment
  checks retain the short route. The existing shared tile/destination cache
  amortizes this work across units.
- Open-route steering preserves lateral position instead of repeatedly
  shrinking it toward the centerline.
- Fully blocked flow units try bounded shoulder directions. Every candidate
  uses wall, swept bitmap occupation, and spatial-job halo checks. Only one
  movement can be accepted, and occupation is updated immediately.
- Each spatial job samples cached desired velocities to visit leading tiles
  first, retaining SIMD groups and avoiding a unit sort.

Live walls near a unit suppress shortcuts certified by an older atlas until
the background rebuild is installed. Both WASM variants were rebuilt and
the simulation rules revision advanced to 25.

## Supplied stalled scene

`tests/4M-1K-stuck.gz`: 2,465,768 initial units, 1000×1000 map, original
orders and buildings. Production scene validation/restoration and game ticks;
Node 24.19.0 memory64, no simulation helpers, dk=20 (one simulated second
per measured tick). No rendering. Baseline loads saved pre-change WASM with
the same current JavaScript/harness. Restore rebuilds navigation and queues
the scene's saved orders; this is a portable scene replay, not an exact
recovery of the original simulation caches.

Final paired replay, 30 ticks / 30 simulated seconds:

| Measurement | Baseline | Final |
|---|---:|---:|
| Moving ordered units at tick 30 (>1 pixel/tick) | 1,419 | 20,489 |
| Distance traveled by ordered units during tick 30, pixels | 23,765 | 521,515 |
| Cumulative net progress toward original saved destinations, pixels | 908,959 | 11,806,150 |
| Mean tick time including cold first tick, ms | 3,052.7 | 3,172.3 |

Net goal progress improves **13.0×**, moving ordered units **14.4×**, at
**3.9% higher measured tick cost** in this pair. Goal progress is the signed
reduction in straight-line distance to each original saved destination,
tracked by stable unit references; dead units are excluded. It distinguishes
useful travel from sideways motion, but is not a path-distance metric around
obstacles. Machine timings vary; other regression checks ran during parts
of these experiments, so these numbers do not establish an isolated CPU
overhead percentage.

An earlier 60-tick replay of the implementation, before the final guard for
newly placed nearby walls, retained 17,586 moving ordered units versus
1,350 with the baseline at one minute. Their tick times were 2,915 versus
3,047 ms. Both complete footprint audits passed. This demonstrates that the
gain persists past the initial movement window; it does not establish that
all congestion is cleared. Most units in this dense scene still do not move
on a given tick.

Final replay data: `baseline-progress.json`, `current-progress.json`.
Earlier long implementation replay: `current-stuck.json`. Incremental logs
are in `baseline-stuck.progress.log` and `current-stuck.progress.log`.

## Controlled rectangle

80,000 normal units in a 400×200 rectangle on a 1000×1000 open map, one
destination at the far right, dk=20. At tick 100 the baseline averaged
808 pixels of forward progress with 31,130 units moving. The implementation
averaged 2,117 pixels with 79,620 units moving. Mean cost over 120 ticks was
110 versus 124 ms. The occupation audit remained exact. These measurements
precede the final nearby-wall guard and use the same movement behavior on
unchanged open terrain. See `baseline-dk20.json`, `current-dk20.json`.

## Validation

Passed:

- `nav-flow-width`: broad travel bypasses representative portals, sustained
  progress at dk=1/20, clear-region table agrees with every wall block,
  newly placed walls override the certificate, footprint audit.
- `occupancy-grid`: independent bitmap oracle finds **zero overlapping
  footprints**, including real helpers and multiple collision planes.
- `occupancy-shapes`: 640 swept-movement, radius, word-seam, edge and release
  cases on each WASM variant.
- `shared-spatial-determinism`: 4,200 active units, serial versus seven real
  helpers, exact agreement including snapshot restore.
- `multiplayer-chaos-determinism 12`, three host helpers: all six map types,
  918 tick hashes compared per map, forced divergence repairs.
- `nav-atlas --pairs=80`: all six terrains, no stuck routes or loops.
- `nav-background`, `nav-shared-build`, `nav-crowd-arrival`.
- `separation-rally`: repeated inward orders at dk=1/20, no deep overlaps.
- `separation-presentation`, `unit-collision-smoothness`.
- `parallel-kernels`, `storage-abi`, `kernel-abi`, `source-loading`.

`nav-reach` still fails its reopened-ring case with identical output using
both the saved baseline WASM and the implementation. The assertion was
preserved.

## Reproduction

From the repository's `rng/defence3` directory, use Node 24+ for memory64.
Allow several GiB of RAM and several minutes for each full-scene run.

```powershell
$env:FLOW_TICKS='30'
node --max-old-space-size=10000 tests/stuck-flow.bench.cjs --baseline --out=tests/test-runs/crowd-flow-20261021/baseline-progress.json
node --max-old-space-size=10000 tests/stuck-flow.bench.cjs --out=tests/test-runs/crowd-flow-20261021/current-progress.json
node tests/nav-flow-width.test.cjs
$env:FLOW_DK='20'
$env:FLOW_TICKS='120'
node tests/crowd-flow.bench.cjs --baseline
node tests/crowd-flow.bench.cjs
```

The rectangle benchmark also accepts FLOW_MAP, FLOW_COLS, FLOW_ROWS and
FLOW_SPACING. Its defaults are the user's proposed 400×200 unit rectangle
on a 1000×1000 map.
