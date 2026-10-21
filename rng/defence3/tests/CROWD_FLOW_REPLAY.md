# Crowd flow and combat reach

The default uses exclusive raster occupancy, local avoidance with a consistent
turning side, and a shared coarse pressure field. No overlap relaxation was added.
The simulation kernels, including acquisition and pressure, are WASM-only.

## Implementation

`sim_traffic.js` owns a 4 by 4 tile field. Movement deposits integer intended
mass and lost forward progress into each spatial job's owned cells. A synchronous
SIMD capture freezes occupancy counts and intentions; helpers then run 16 Jacobi
passes and generate pressure gradients plus collective drift. Publication occurs
after two simulation steps, regardless of helper completion time. Background
jobs never sample moving units or the mutable occupancy bitmap.

The movement kernel samples the published field in constant time. Blocked units
try at most four shoulder directions. A second pass within each checkerboard job
lets otherwise stationary units yield using their remaining movement budget.
Every accepted position still requires a swept exclusive footprint and a valid
terrain segment. Occupied movement uses one scalar contact path independent of
whether restored slots form contiguous SIMD runs; bulk indexing, status and
pressure computation remain vectorized. Same-row occupancy sweeps test packed
entered spans instead of repeatedly testing the complete disk.

At map size 1000, traffic adds 3,875,160 bytes per collision plane, independent of
unit count. The default single-plane occupancy bitmap is approximately 7.66 MiB.

Workers now finish automatic approaches at their existing one-tile interaction
range, without needing to enter the occupied final node. Manual move orders keep
their destination. A blocked spawn is deferred instead of blocking the entire
production queue; at most 64 failed exits are attempted per step.

## Comparison switches

| URL parameter | Behavior |
| --- | --- |
| `traffic=0` | Previous occupancy movement response |
| `traffic=1` | Local avoidance only |
| `traffic=2` | Pressure only |
| `traffic=3` | Pressure and local avoidance, default |
| `trafficLocal=0` | Previous shoulder-selection policy |
| `trafficPasses=1` | Fused movement/yield comparison |
| `trafficResponse=0` | Original physical-speed pressure response |

These settings are forwarded to the simulation worker. They change simulation
outcomes and must agree across peers; use a fresh match for comparisons.

## Reach and initial balance

Combat units start at one area. At level 20 and research 10:

| Unit | Maximum areas |
| --- | ---: |
| Basic infantry | 1 |
| Fast, tank, boss, mole, snake, king | 1 |
| Fire | 3 |
| Ice | 3.5 |
| Flying | 4 |
| Poison | 4.5 |
| Water, laser | 5 |
| Scout | 6 |

Ordinary turrets reach 2.5–5 areas; sniper reaches 8 and watchtower 10.
Laser-network range remains special. Longer ranged units retain slower maximum
fire rates (0.045–0.10 seconds versus melee's 0.025); several also have lower
base energy and slower base attacks. Boss retains a 0.05 second maximum-research
cooldown. Sniper energy falls from 1500 to 600.
These are provisional balance values. Sight covers effective attack range,
including after incremental research publication. Workers remain unarmed.

Range scaling is precomputed into shared rows. The default area acquisition
builds shared nearest-area answers on helpers. A query checks at most four source
tiles and four candidates per hostile owner, rather than scanning every unit in
an enlarged radius. Turret work is separately timed because it can still grow
with reach and the number of targets in range.

## Replays

Use a Node runtime with memory64 support (the bundled Node 24 works) for the full
scene. Builds are installed in `src/sim/sim_wasm_bin.js` and
`src/sim/sim_wasm64_bin.js`; no custom binary override is necessary.

```text
node tests/crowd-front.bench.cjs --helpers=7 --ticks=60 --current-balance --out=tests/test-runs/crowd-front-20261021/verified-scene.json
node tests/crowd-front.bench.cjs --helpers=7 --ticks=60 --current-balance --max-stats --out=tests/test-runs/crowd-front-20261021/verified-max.json
node tests/crowd-front.bench.cjs --helpers=7 --ticks=60 --current-balance --max-stats --short-reach --out=tests/test-runs/crowd-front-20261021/verified-max-short.json
```

The scene contains 2,437,842 units, with roughly 300,000 units retaining movement
demand. Movement ratios refer to that demand, not to every idle unit on the map.
`--max-stats` makes units and buildings level 20, publishes research 10, fills
health and resources, and removes pending research orders. `--short-reach` keeps
the same cooldown profiles while limiting ordinary reach to one area, isolating
the larger-range cost. `--current-balance` replaces the saved stat tables with
current tables while retaining the scene's map and other settings. Without it,
portable scenes deliberately restore their saved balance configuration.

The saved-stat replay before the unified balance table (`verified-melee1-scene.json`)
at step 60 had 94.88% moving over one pixel; 47.39% reached at least half stat
speed. Mean step cost was 1,838 ms. All raster
occupancy audits passed. Most units moving is a large improvement over the
earlier roughly 14–16% result, but this is not 95% of units at full stat speed.

Balance now lives in the single `THING_STATS` definition table. See
[THING_STATS.md](THING_STATS.md) for the descriptor format and the initial role
audit. Tower range is explicitly researchable; old saved research lists omitted
it. Measurements above precede those balance edits and should not be treated as
measurements of the revised maximum-range matchups.

The unified-table maximum-stat replay (`unified-max.json`, 60 measured steps,
seven helpers, level 20/research 10) finished with 93.31% of ordered units moving
and 30.88% reaching half stat speed. Mean step time was 2,366 ms; occupancy had
zero position mismatches and matching footprint bit counts, with no simulation
errors. This is the revised balance workload, not a matched measurement of the
data refactor's isolated cost. TPS optimization is deferred to the next session.

The controlled 3,200-unit plug replay passes 95% moving and 85% half-speed
thresholds. Opposing destinations and an impassable wall are covered too. Speed
checks allow less than 1% quantization error. No terrain crossing or occupied
footprint overlap is allowed.

```text
node tests/traffic-pressure.test.cjs
node tests/shared-spatial-determinism.test.cjs
node tests/shared-spatial-determinism.test.cjs --dk=20
node tests/occupancy-shapes.test.cjs --wasm32
node tests/occupancy-shapes.test.cjs
node tests/occupancy-grid.test.cjs
node tests/worker-walk.test.cjs
node tests/worker-approach-occupancy.test.cjs
node tests/spawner-queue-performance.test.cjs
node tests/scene-orders.test.cjs
node tests/combat-reach.test.cjs
node tests/thing-stats.test.cjs
```

The worker walk test starts its movement timeout after the network applies the
manual order. The determinism fixture sets the coarse step size before issuing
orders, so its initial command budget matches the replay step size.

## Background references

The aggregate field follows ideas from [Continuum Crowds](https://grail.cs.washington.edu/projects/crowd-flows/78-treuille.pdf),
[Aggregate Dynamics for Dense Crowd Simulation](https://gamma.cs.unc.edu/DenseCrowds/narain-siga09.pdf),
and the [Liquid War core algorithm](https://www.gnu.org/software/liquidwar6/manual/html_node/Core-algorithm.html).
This implementation combines a coarse field with hard discrete footprints; it
does not implement deformable, area-preserving individual droplets.
