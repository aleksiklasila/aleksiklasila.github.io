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

# 3D rendering benchmark

`.claude/renderbench.js` runs in the browser (see its header). `RB.setup()`
starts a seeded 120×120 arena with **500 combat units and 40 turrets per
team**; ticks run untimed between frames (three frames per tick) and each frame
times `renderFrame` at 1920×1080. Scenarios: `move` (both armies ordered to
3–4 rally points), `move` with all 500 own units selected (outlines, rally
lines), and `fight` (attack-move into the enemy base: turrets firing, damage,
particles).

## Findings

- The GPU was not the limit on the test machine: after `gl.finish()` a 3D frame
  ends when its CPU work ends. The cost is JavaScript in `build3DFrameData`
  (scene objects) and `render` (sorting, shadows, instance data).
- Fights were worst. Every damaged unit has its own 2D status panel, so 3D
  made one draw call per panel (90–190 per frame) and created and mipmapped
  5–12 new textures from canvases every frame. 2D already used a texture array.
- The multisampled scene wrote a second (packed depth) color attachment and
  resolved depth every frame; only health-bar overlay occlusion reads it, and
  none are currently produced.

## Changes

- Exact 2D panels on 3D models come from the flat renderer's sprite atlas
  (texture array, GPU-only uploads) with a per-instance layer: one draw per
  model/animation instead of one per panel, and no texture churn.
- Packed depth is written/resolved only in frames that read it back; the MSAA
  target has no packed-depth attachment.
- Textured instance groups persist between frames; primitive shadows are
  written straight into instance arrays; matrices are written in place.
- Floor items come from the row-major tile index instead of scanning every
  visible tile; unit-occupied tiles use a stamped typed array.
- Light gradients are cached per tile in typed arrays; a unit's own light is
  computed once per tick.

Visuals: a same-state A/B (`RB.rendererAB`) renders identical game states
with both `renderer3d.js` versions. Differences stay at the re-render noise
floor (≤1 color level in 32×48 block averages; 2D pixel-identical).

## Measured results

Median of three interleaved page loads per version, CPU ms per frame
(`RB.suite({ detail: false })`). Baseline `fcd332c`.

| Scenario | 3D before | 3D after | Before / after | p95 before → after |
|---|---:|---:|---:|---:|
| Move, zoomed out | 5.74 | 4.00 | 1.44× | 11.8 → 8.1 |
| Move, zoom 1 | 5.00 | 3.73 | 1.34× | 9.2 → 6.7 |
| Move, 500 selected, zoomed out | 7.53 | 4.99 | 1.51× | 24.8 → 8.8 |
| Move, 500 selected, zoom 1 | 7.74 | 4.55 | 1.70× | 24.3 → 8.3 |
| Fight, zoomed out | 9.98 | 9.22 | 1.08× | 20.3 → 17.7 |
| Fight, zoom 1 | 13.01 | 7.79 | 1.67× | 40.2 → 13.4 |

Run-to-run noise on this machine is large (±30% for one run), so single rows
are indicative; the draw-call and texture-upload reductions are exact counts.
2D stays ~2–3 ms. The remaining 3D gap in fights is mostly per-tick unit
panel rebuilds (attack flashes change every attacking unit's panel each tick)
and per-object shadow/instance work in `render`.

# Simulation: one hidden class per unit

With ~3000 units the simulation, not rendering, set the frame rate in both
views (profiles: `gameTick` ~75–85% of a frame).

## Finding

Units received about 80 fields on first use (worker state, collector/healer/
builder memory, astar budget, pending paths, damage flash...), in orders that
depend on unit type and history. After 160 benchmark ticks live units had
**16–77 distinct property layouts**, so V8 treated every unit field read in the
tick loops (`Unit.update`, collision, spatial buckets, visibility, targeting)
as megamorphic. That cost was spread over every hot function rather than
showing as one hotspot.

## Changes

- The `Unit` constructor declares those fields (as `undefined`, i.e. unchanged
  behavior) in one fixed order: every unit now has one layout.
  `tests/unit-hidden-class.test.cjs` fails if a new lazily set field splits it
  again; the benchmark reports `unitShapes`.
- The deterministic update orders (units and each building list) reuse the
  sorted order while the list and its sort keys are unchanged; the seeded
  shuffle still runs every tick. The deferred-path pass shares it.
- Area buckets count members per owner in an array instead of a `Map` (read
  for each area in range by every moving unit's drive-by attack check).
- Salvager search builds its spawner set only when a marked cell item is found.

Snapshots drop `undefined` fields (JSON) and restore into a new `Unit`, and
lockstep hashes use explicit fields, so neither changes.

## Measured results

`node tests/large-battle.bench.cjs --compare` / `--compare-extra`, baseline
`578a714`, AMD Ryzen 7 4800H, Node v22.20.0; mean ms per tick of the 120
measured ticks, averaged over the paired runs. Every pair's gameplay digest
and lockstep hash are identical.

| Scenario | Before | After | Before / after | p95 before → after |
|---|---:|---:|---:|---:|
| Idle | 28.53 | 18.48 | 1.54× | 36.8 → 24.3 |
| Group movement | 33.74 | 21.49 | 1.57× | 46.0 → 32.2 |
| Group attack-move | 38.16 | 18.87 | 2.02× | 48.9 → 27.2 |
| Working | 41.64 | 27.17 | 1.53× | 61.5 → 38.8 |
| Production + rally | 73.06 | 37.41 | 1.95× | 97.2 → 51.2 |
| Crowded armies | 57.50 | 31.26 | 1.84× | 74.3 → 42.0 |
| Siege | 44.95 | 28.19 | 1.59× | 54.7 → 37.6 |
| Attack-move, multiplayer branch | 38.41 | 22.98 | 1.67× | 51.9 → 33.7 |
| Rally, multiplayer branch | 71.82 | 42.22 | 1.70× | 93.0 → 63.3 |

Remaining large costs: per-player visibility (~15%), the unit collision
loop, worker target searches that scan every building (large in these
1000-building fixtures), and path following.

# Combat effects, role models and animations

Attacks, shots and hits are drawn as GPU effects instead of per-object
particles, and every unit role has its own 3D body plan and rest pose.

## Design

- **Visual records, not particles.** A unit attack, tower shot or projectile
  hit appends one record (kind, endpoints, start tick, style) to a fixed
  4,096-entry ring in `particle.js`. The simulation never reads it, and it is
  not in snapshots or hashes. Records are released when they expire, and a
  rewind (new game, resync) drops them.
- **One effect pass.** `effects3d.js` turns live records, projectiles,
  particles, laser fences and building activity into instances of four
  shared meshes (box, orb, spike, ground decal), written straight into typed
  arrays (`FxBatch`). `renderer3d.js` uploads them once per frame and draws
  one instanced call per mesh. Decal patterns (rune circles, slash crescents,
  claw marks, crossed cuts, shockwaves, splats, shadows) are procedural in
  the fragment shader, so there are no textures.
- **3D and 2D share it.** The 2D view draws the same instances in an oblique
  projection: resting heights are flattened and arcs and hops lift shapes up
  the screen, with a ground shadow under anything airborne.
- **Unit panels omit attacks.** Attacks were drawn into each unit's 2D status
  panel, clipped to its footprint, and changed the panel's signature every
  tick of a fight. Panels now show the unit only (the canvas fallback
  renderer still draws attacks), so fighting units stop re-rasterizing.
- **Models and poses** stay one merged mesh per role and one draw per
  role/pose group. New joints (quadruped legs, neck, spinning rings) and an
  idle mode are evaluated in the vertex shader; picking mirrors the pose.
- Secondary pieces (trails, debris, smoke, building activity) are skipped
  when a tile is under ~14 pixels.

## Measured results

`.claude/abbench.js`, 2,200 units and 80 turrets on a 120×120 arena, 1400×900
viewport; three interleaved page loads per version (HEAD exported to an
untracked copy), mean CPU ms per frame. Single-player runs are not
deterministic, so unit counts at the same step differ between loads.

| Scenario | Before | After |
|---|---:|---:|
| Move, 3D zoomed out | 10.35 | 7.60 |
| Move, 3D zoom 1 | 5.23 | 3.70 |
| Move, 2D | 2.29 | 2.20 |
| Fight, 3D zoomed out | 16.80 | 11.20 |
| Fight, 3D zoom 1 | 20.10 | 12.42 |
| Fight, 2D | 5.41 | 6.92 |

The 2D fight row compares different battles: at the matched step the new
build had 1,628 units alive against 1,173 (3.0 vs 4.0 µs per unit), and it
rasterized 330–410 unit panels per 60 frames against 1,081. The effect pass
itself measured 0.12–0.43 ms per frame in these fights.

Simulation: `large-battle.bench.cjs` combat, crowded and siege runs of HEAD
and this version have identical gameplay digests and lockstep hashes, at
25.3 → 23.4, 36.5 → 36.8 and 31.9 → 30.6 ms per tick (one run each).

## Reproduce

```js
// In the page (run on each version, alternating loads):
await (0,eval)(await (await fetch('/rng/defence3/.claude/abbench.js')).text());
AB.start();   // then read AB.result
// Visual checks (arena of every role and turret):
await (0,eval)(await (await fetch('/rng/defence3/.claude/visbench.js')).text());
```
