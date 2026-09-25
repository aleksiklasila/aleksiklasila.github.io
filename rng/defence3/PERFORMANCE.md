# Large-battle simulation benchmark

The benchmark runs the real `gameTick`, unit/building constructors, workers,
pathfinding, visibility, production and action processing under Node. Rendering,
audio, DOM updates and network transport are excluded. These are simulation
timings, not browser frame times or FPS estimates.

Each scenario starts with two teams, **1,500 units and 501 buildings per team**
on a seeded 128×128 map. Units cover 12 types (six combat and six worker types);
buildings include five turret types, barracks, all six worker spawners and
housing. Resource mines and normal fog/area calculations remain enabled.

- `idle`: spread-out armies; workers can find nearby resources.
- `moving`: five groups per team receive new movement orders every 40 ticks.
- `combat`: interleaved armies receive group attack-move orders.
- `working`: construction, salvage, gathering and research workloads.
- `rally`: 750 production buildings receive rally changes and fully funded
  units every 40 ticks. The population grows to 6,000 units.
- `crowded`: dense mixed armies exercising collisions, combat and worker AI.

Every run executes 160 ticks; the first 40 warm up the code and caches. The
remaining 120 include command processing. Two paired runs alternate baseline /
optimized order. Runs are serial. Both the game's lockstep hash and a SHA-256
digest of unit positions, health, paths, commands, worker assignments, building
queues and player state must agree between versions.

## Measured results

AMD Ryzen 7 4800H, Node v22.20.0; baseline commit
`3e3ed3e280b7f2430198627f55076c2f29bb8333`. Numbers below average the two runs'
mean tick times. The raw samples' summaries are in
[large-battle-results.json](tests/large-battle-results.json).

| Scenario | Before, ms/tick | After, ms/tick | Before / after |
|---|---:|---:|---:|
| Idle | 30.08 | 28.84 | 1.04× |
| Group movement | 33.46 | 33.32 | 1.00× |
| Group attack-move | 38.59 | 40.40 | 0.96× |
| Working | 48.67 | 42.92 | 1.13× |
| Production + rally | 81.72 | 72.85 | 1.12× |
| Crowded armies | 63.30 | 59.66 | 1.06× |

The production phase in the rally scenario, including real unit creation and
rally pathfinding, falls from **463.27 ms to 195.47 ms** summed over the measured
120 ticks: **2.37× faster**. The three production/command burst ticks average
**221.54 ms → 126.17 ms**, a **1.76×** improvement. Ordinary movement does not
improve. Attack-move measured 4.7% slower on average, with substantial run-to-run
variation; there is no demonstrated combat speedup. These results do not
establish an across-the-board frame-rate improvement or sustained 20 TPS for
the most demanding cases.

All 12 paired scenario replays have identical final gameplay digests and
lockstep hashes. Three additional paired checks also pass: siege (172 buildings
destroyed), multiplayer combat, and multiplayer production/rally. See
[large-battle-extra-results.json](tests/large-battle-extra-results.json).
`--compare-extra` reproduces those checks; multiplayer activates the real
simulation branch (including exact nearby-unit counts), without network
transport. The additional single-run timings are not included in the table.

Validation: all **29 regression test files pass**. Dedicated scheduler tests
compare 120 fixtures over consecutive ticks, including priorities, ties,
population caps, failed spawning and the iteration guard. Worker tests compare
indexed results with exhaustive scans after assignments, releases, deaths,
moving targets and cache resets.

## Changes

**Production scheduling:** replace repeated scans of all production buildings
after every spawn with a binary priority heap. Only the consumed queue needs
another readiness check. Priority, array-order ties, population caps, failure
behavior and the 2,048-spawn guard are preserved. With 1,000 ready buildings,
queue-front checks fall from 500,500 to 1,000. The isolated scheduler test against
the exhaustive reference measured about 22.5 ms → 0.20 ms (114×); this excludes
unit creation and pathfinding.

**Worker reservations:** share a tile/profession index between searches and
extend it on assignment. Deaths, releases and current owners are checked live.
Moving healer targets retain live coordinate checks. A 3,000-worker isolated
lookup workload measured about 1,534 ms → 9 ms for 60,000 queries against the
exhaustive reference (170×). This is a stress test of fallback occupancy queries,
not a whole-tick speedup.

**Spawner lookup:** partition production buildings by type once per tick and
avoid sorting every return-route candidate list. Existing deterministic
distance/coordinate/id comparisons still decide ties. Construction and health
eligibility remain live, and placement/removal/snapshot changes rebuild the
index.

## Reproduce

```powershell
node tests/large-battle.bench.cjs --compare
node tests/large-battle.bench.cjs --compare-extra
node tests/large-battle.bench.cjs rally
node tests/large-battle.bench.cjs rally --baseline
node tests/large-battle.bench.cjs combat --multiplayer
node tests/spawner-queue-performance.test.cjs --bench
node tests/worker-target-index.test.cjs --bench
```

`--baseline` loads tracked scripts from Git HEAD into the same fixture. To
repeat the recorded comparison after committing these changes, first set:

```powershell
$env:DEFENCE_BENCH_BASELINE = '3e3ed3e280b7f2430198627f55076c2f29bb8333'
```

The comparison writes `tests/large-battle-results.json`, including the baseline
commit, CPU, Node version, timings and state hashes. There are no timing
thresholds in regression tests.

## Limits and next steps

These changes remove quadratic work in specific workloads. They do not promise
a 2× improvement to the entire simulation. Dense movement/combat, visibility,
unit updates and pathfinding remain substantial costs. The headless benchmark
does not validate render performance, main-thread responsiveness or a Worker
handoff. No simulation Worker or shared-memory dependency was introduced.

The next architectural step should be measured separately: isolate a pure
simulation entry point and define render snapshots and input/effect messages
before moving it off the main thread. A data-oriented rewrite should target
the unit-update passes demonstrated hot by profiling; copying every object
between threads would not address their cost.
