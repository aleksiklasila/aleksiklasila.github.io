# Balance scenario review

## Scenario sets and counters

The purpose is to find viable counters and flag things with no observed defeat,
not to make every matchup equal. The HTML **Counters** view distinguishes a
complete defeat (no survivors, opponent still alive) from partial damage. Coverage
follows the plot filters. No counter observed is not proof of invulnerability.
Shared-map interference remains a limitation, and count-limited energy comparisons
are explicitly identified. No gameplay balance values are modified.
Scouts and watch towers are excluded from both sides of balance matchups.
Worker fixtures still cover all applicable build/heal/salvage targets.

Snapshots are organized under `tests/scenarios/equal_numbers/` and
`tests/scenarios/equal_energy/`. Worker snapshots remain at `tests/scenarios/`.
The shared `tests/scenarios/manifest.json` registers all sets for measurement
and benchmarking. Existing equal-number snapshots are retained.

Generate the second set:

```powershell
node tests/balance/generate-energy-scenarios.cjs --min-count 1 --max-count 1000
```

Per pairing and L/R, counts match starting base health-energy using actual unit
energy / building maxEnergy formulas. A 2:1 health ratio produces 50:100 things;
100:1 produces 1:100; 500:1 produces 1:500. Normally the cheaper force stays near
100. Counts are rounded to individuals and bounded by the requested min/max.
Lasers retain paired endpoints. Research investment and upkeep are separate.
The scene's actual energy pools can differ through normal effective-level rules;
those remain unchanged and measurements record their actual starting health.

Every energy arena records `counts`, `requiredCounts`, `countBounded`,
`plannedStartingEnergy` and `energyMismatchFraction`. The manifest records the
configured bounds and `equal_energy/count-limits.json` lists bounded cases.
These are still generated; they are not claimed to have equal budgets. Plot
diamonds mark them, and a filter hides them. Counts and energy appear on hover
and in details/CSV. Unit/turret arenas grow to 58×58 tiles (32 clear tiles on
the full 480-group maps); crossing courses use 90×90 (27 clear tiles).

The report plot fills the window with the bundled, offline Plotly library:
wheel/box zoom, pan, reset, hover, click details and image export. **Set** filters
equal numbers vs equal energy. **Data**, **Counters**, and **?** open the
tables, counter coverage and explanatory text without shrinking the plot.

## Background measurements and reports

From the repository root, start a detached sweep with:

```powershell
./tests/balance/start-fights.ps1 -Seconds 60 -Scenarios 'fight-2-teams-*'
```

This measures each matching scene for 60 wall-clock seconds after loading, using
the normal adaptive delta ticks. It resumes compatible results and updates
`tests/balance/reports/adaptive/report.html` after every completed scene.
`progress.json` records loading/measuring state, counts and failures;
`background.log` records progress during measurement. Failed scenes are recorded
and the sweep continues. One process at a time avoids memory pressure and timing
interference on these large maps. The process continues after the chat turn ends.

Stop at the next tick boundary:

```powershell
node tests/balance/run-fights.cjs --stop --out tests/balance/reports/adaptive
```

Use `--regenerate` on the foreground runner (or `-Regenerate` on the PowerShell
launcher) to rebuild both fight sets before measuring them. Progress reports the
current generator. Changed snapshots automatically invalidate cached measurements.

Foreground runner options include `--seconds`, `--scenarios` (comma-separated
globs), `--jobs`, `--out`, and `--resume`. Regenerate the interactive HTML, CSV,
JSON and Markdown reports from saved measurements without rerunning fights:

```powershell
node tests/balance/fight-report.cjs tests/balance/reports/adaptive
```

Primary ranking compares the percentage of each side's starting health-energy
lost. Absolute damage, starting energy, upkeep, creation/research budgets and
movement Astar are separate columns. Normal effective levels are retained.
Upkeep does not count as health damage. Equal-cost counts describe affordability,
not a measured count required to win. Mixed groups and hazard courses are flagged.

## Worker scenes and benchmarking

Generate worker scenes with `node tests/balance/generate-work-scenarios.cjs`.
`work-1-team-all-workers_R*.json.gz` includes all 20 base levels: energy/Astar
mines and farms, mixed collection, salvage, healing, production queues, research
and construction. One set of clouds appears in L1 construction because normal
gameplay permits only one of each cloud type per owner. Research jobs reserve
five target stats at R0 so work remains available even in the R10 file.

The same snapshots are available to a separate benchmark runner:

```powershell
node tests/scenarios.bench.cjs --seconds 60 --scenarios 'fight-*,work-*' --out tests/balance/reports/scenario-benchmark
```

It records load time, completed TPS, wall/game time, adaptive delta tick histogram,
tick duration percentiles and memory, using the real headless simulation. Rendering
is excluded. Use `--jobs 1` for comparable performance measurements; benchmark
runs are explicit and are not started by the balance runner. `--load-only` uses
the Offline file reader/restorer and checks entity counts without advancing ticks.
Results and a progress table are saved after each scene.

Generate with `node tests/balance/generate-scenarios.cjs` from the game directory.
Validate representative imports with `node tests/balance/scenarios.test.cjs`.
Open the game, choose **Play Offline → Load**, and select any `.json.gz` in
`tests/scenarios/`. Files are ordinary compressed portable game scenes.
Generation replaces files with the same name; unrelated files are preserved.

Names use `fight-2-teams-unit_fast_R5` or `fight-2-teams-building_poison_R5`. Each file includes every
thing level from 1 through the default maximum of 20, for every opponent type.
Research samples 0, 5, 10 for both fight sets and worker scenarios. Each fight set has 84 files, with up
to 440 matchup groups in one file. Both sides of each group use the same L/R;
cross-level matchups and count searches belong to the next phase.
R means every researchable stat of that participant's type is at R, including
cost/upkeep reductions and building max-level research, not only attack research.
Entities are complete, use the proper stacks for L, and have full base health.
There are no workers, income sources, reinforcements, automatic upgrades, or kings
outside the actual king matchup. Normal combat, adjacency, resistance, upkeep,
navigation, and construction stat formulas remain unchanged.
Each team also has one L1 house at an outer map corner, outside all matchup
groups. Destroy Base requires a building to keep a team alive; units alone do
not count. These noncombat houses prevent a defeat immediately after loading.
They are listed under `anchors` and excluded from matchup counts and costs.
The match's overall win/defeat result is consequently not a matchup result.

## Arena layout

Each file repeats 100 blue focal things against 100 red opponents, one opponent
type and level per pair. Read pairs left-to-right, then top-to-bottom on a
2000×2000 map. Groups are spread evenly in a square grid, with a minimum of
32 clear tiles between their 36×36 bounds. Army maps use 22 columns, 90-tile
origin spacing and 54 clear tiles; crossing maps use 17 columns, 117-tile
spacing and 81 clear tiles. There are no artificial barriers.
`manifest.json` lists every arena's row, column, coordinates, types and counts.
`pair-order.md` is a small lookup table for the opponent order.
The camera opens on arena 1; zoom out to inspect the rest of the map.

- Army maps cover all damaging units (including king) and ordinary turrets.
  Both mobile armies attack-move toward the same midpoint between them. Against
  turrets, units attack-move into the turret formation's center. Units are individual
  entities, not a stack standing in for 100 combatants.
  Turret blocks have a two-tile entrance toward the enemy leading to the center;
  displaced turrets are placed behind the block, keeping exactly 100. This leaves
  the rally destination walkable. Every group's explicit team destinations are
  also recorded under `rallyTargets` in the manifest.
- Turret vs turret uses a 14×14 checkerboard alternating teams on every tile:
  exactly 98 turrets per team. Turrets vs units and units vs units use 100 per
  team and start with an approach gap.
- Laser and floor-item maps are crossing courses against each damaging unit
  type. Blue hazards remain stationary; 100 red units move across each field.
  Laser fields contain 50 pairs / 100 actual towers. Each pair has a walkable
  beam tile at L1, with ten lanes and five successive gates. Normal additional
  links at higher levels are retained. Floor fields have ten lanes of ten items.
  Orders ask units to cross; normal routing may avoid hazards. Exposure must be
  measured later rather than assuming every unit touched every item.
- Clouds, non-damaging support, and producers are excluded. Sand is included
  because its damage comes from the floor kernel rather than the card's damage
  field. Purely non-damaging water puddles are excluded.

Small areas partition the tiles for normal area-based targeting and visibility.
Groups stand on open ground with no divider walls or forced corridors. Only the
turret tiles themselves are walls, as required by the normal game. Nearby groups,
long-range effects, shared resources and stragglers can mix during a long batch run.
These shared maps are **review fixtures, not independent measured fights**.
Do not derive strength rankings from their aggregate end-of-game result.
The generator exports `makeScene` with an opponent subset argument, allowing a
future runner to use one matchup per real simulation and parallel worker processes.
Large finite sandbox reserves fund normal upkeep; they are not participant costs.
Generated snapshots, manifest and pair lookup are saved locally and ignored by
Git. The generator prints the current total size. Geometry compression is cached;
every output remains a standard single-member gzip scene loadable by the game.
After successful generation, obsolete per-level snapshots from the previous
manifest are removed; unrelated files in the scenarios directory are retained.

## Recorded cost inputs

The manifest profiles use the game's current stat/research formulas and separate
creation energy per entity, creation Astar per entity, upkeep per second per entity,
research energy paid once per type/team, raw stats, traits and stack counts.
Unit creation energy follows the actual spawn payment (researched unit health),
not the unit card's nominal price. Building creation energy follows the build-menu
health cost. For alternative build/merge paths and producer infrastructure, a
future report must explicitly declare the chosen accounting convention.
Profiles describe unboosted stats; live adjacency can change effective levels.
Research costs are never multiplied by 100. Astar currency and pathfinding work
are different quantities; the latter needs separate runtime instrumentation.

## Next phase after visual approval

Run the real simulation in bounded parallel isolated workers. Keep gameplay ticks
and routing intact. Sweep both sides' independent level/research profiles; first
bracket n, then search for the smallest winning challenger army. Record timeouts,
stalemates, inability to reach/damage a target, both-side elimination, and any
unbracketed threshold separately. Count outcomes need monotonicity spot checks:
crowding, AoE and discrete layouts can make plain binary search misleading.
Repeat mirrored orientations and seeds near thresholds; retain threshold fixtures.

Report measured energy/Astar spending, elapsed upkeep, research investment,
navigation work, survivors, damage and exposure; show raw resource axes separately
before applying configurable weights or a declared stationary-defense allowance.
Keep resistance, mole/tower immunity, flying, AoE and laser geometry as explicit
matchup tags. Rank broad strength, worst weaknesses and missing counters across
opponents, rather than averaging away a hard counter. Crossing courses should
rank exposure-adjusted damage and survival, not a fictitious elimination threshold.
No balance constants are changed and no strength claims are made at this stage.
