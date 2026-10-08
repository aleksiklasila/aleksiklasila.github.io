# Brains off the main thread

Goal (user, 2026-10-08): the simulation thread runs only the parallel
"motor" kernels — per entity O(1) move, turn, timers, committed attacks,
separation — plus O(1) application of decisions. Every decision ("brain":
targeting, engaging, worker AI, path requests, tower targeting, effective
stats) runs on the tiered helper lanes, committed at fixed ticks. Main
thread under 50 ms at 400k units (200000-1000, ACTIVE+BATTLE, full
visibility), then optimize the lanes.

## Why this is a rewrite

Helper threads see only SharedArrayBuffer / wasm memory. `Unit` objects and
what they reference (targetUnit/targetBuilding/attackTarget objects, path
arrays, worker memory, buildings, projectiles) live only in the simulation
thread's heap. So "Unit.update on helpers" means: every remaining branch of
Unit.update (and Tower/Barrack/spawner updates) re-implemented as kernels
over columns, with object references replaced by slot + id columns and
pools. Objects stay as views (accessors over columns) for the UI, snapshots
and tests.

## Where the main thread goes today (400k, mean ~100 ms)

| phase | ms | what |
|---|---|---|
| unit pass | 26 | ~1,900 Unit.update calls (worker AI, in-range ice/laser/ram/building attackers, chases, attack-movers), ~7,800 kernel-output commits (engage 1,850, target died 1,050, hold fire 1,400, chase in range 1,150, drive-by fire) — all object work |
| simMoveRun | 18 | movement kernel 8.6 (wall, 8 threads), drive-by look 4, combat scan, spatial counts, main-thread setup |
| hash | 7.5 | lockstep hash slices |
| separation | 6.5 | commit + slow path |
| adjacency | 5 | |
| effective stats | 4.5 | |
| status, visibility, hits, nav, orders, stats... | ~30 | |

Measured per tick: in-range attackers that still run Unit.update are
mostly special styles at their attack tick (ice ~310, laser ~110, ram ~70)
and building targets; the kernel fires only plain styles at units.

## Target architecture

1. **Columns are the state.** Targets: `tgS`/`tgId`/`tgK` (slot, id, kind:
   unit/structure tile/none), attack target mirror, forced flag; paths: the
   path window pool generalized to whole-path node pools; worker state: an
   enum column + worker sidecar pool (carry, site, home spawner as ids/tiles).
   Objects read through accessors; no gameplay code holds object refs.
2. **Motor kernels (main tick, parallel, O(1) per entity):** move along the
   committed step / path window / flow field, turn, count timers down, fire
   when a committed target is in range and the timer is out (any style:
   hit records with style; ram recoil; building targets by tile), apply the
   tick's decision records. One kernel per entity class if lighter.
3. **Brain lanes (helpers, tiered 10/5/1 TPS, staggered):** read an
   immutable tick-T snapshot, write compact decision records (target,
   move goal, engage, drop target / resume attack-move, path request,
   worker task step), committed at T + L on every peer (lane contract
   already used by acquisition, worker search, healer candidates).
4. **Effects/presentation:** sounds, attack FX, damage visuals emitted as
   event lists by kernels (no inline object calls).
5. **Deaths/spawns/removals:** batched (dead column, retire kernel,
   compaction) as today.

Decisions get latency (a lane's period plus commit lag): gameplay changes,
so `SIM_RULES_REVISION` is bumped per stage. Determinism contract unchanged:
same snapshot in, same records out, committed at the same tick, regardless
of helper count; JS and Rust twins byte-identical.

## Rules for the rewrite (user, 2026-10-08)

- Remove Unit.update, building/tower/spawner update and every per-type
  update from the tick altogether. The main thread keeps only the parallel
  motor kernels and O(1) application of committed decisions.
- NEVER more than O(1) per thing on the main thread: no per-unit loops,
  searches, scans, A* or BFS for a single unit there. Such work exists
  only as batched, parallel jobs on the helper threads (like the flow-nav
  builds), whose results the main thread reads in O(1).
- No searches on the main thread (no area BFS, range scans, path work):
  range, targets and routes are worked out on helper lanes (flow-nav-like
  precomputation where it fits) and handed over as instructions.
- Performance first: large changes, then benchmark; bit-exactness tests
  per small step are not required at this stage (determinism across peers
  still holds by construction: lanes read snapshots and commit at fixed
  ticks).

- Wasm only (user): kernels are written in Rust; JS twins are not kept
  for new kernels and existing ones may be removed.

## Progress (400k, ACTIVE+BATTLE, 7 helpers, full visibility)

| step | mean | p50 | unit pass | simMoveRun |
|---|---|---|---|---|
| session start | 117.5 | 108.6 | 33.7 | 21.6 |
| memory pass (Float32, packing) | 106 | 97 | 30 | 18 |
| combat brain (holds/chases off the object path) | 91 | 83 | 12.0 | 17.9 |
| adjacency on a helper lane | 84.5 | 76.6 | 11.8 | 17.4 |
| drive-by look into the brain lane | 79.1 | 71.4 | 10.9 | 12.4 |
| fire unified, facing in presentation, hash kernel in Rust | 76.6 | 69.7 | 9.9 | 11.8 |

Done:
- Combat brain (helper lane T10, chained after the acquisition scan):
  cmMode bits 0-1 the move (0 own order, 1 stand, 2 toward the target),
  bit 4 fire (any movement); motor in the movement kernel (Rust); object
  engagement, retaliation and drive-by looks off for combat units.
- Adjacency: signature grid + flood on lane T5 (JS kernel), committed every
  8 ticks, members applied 2000 a tick.
- Facing: presentation only (fire target, else movement, smoothed); the
  motor writes no facing.
- State hash: column hashing in Rust (snap_region, per-job lists merged),
  its own lane (SIM_LANE_HASH).
- Win check once a tick (was a scan per destroyed building).
- Resync drops lane state on every peer (adjacencyLaneReset,
  combatBrainReset).
- Tried and reverted: Rust spatial counts by row bands (unbalanced in
  battles, slower than the per-slot JS kernel with atomics; same-block skip
  kept).

Main thread now (ms): simMoveRun 11.8 (movement kernel 8 wall), unit pass
9.9 (workers ~3.3, attack-movers/movers on paths, building attackers),
hash 8.0 (JS object hashing ~5.8: rotation group objects, buildings,
globals), separation 5.6, effective stats 4.5 (object apply), status 2.8,
visibility 2.6, hits 1.9, orders 1.8, nav 2.9, stats 1.2, laser 1.2.

Next (in order):
1. Workers (stage 4) and building updates over a structure table (stage S).
2. Effective stats as (owner, type, level) tables applied by a kernel.
3. Hash: object parts from columns / lanes; remove the remaining JS.
4. Remove JS kernels that have Rust twins (user rule); port the rest.

## Structures as columns (stage S, next; prerequisite for workers and
## building updates)

- A structure table like the unit columns: per structure slot owner, type
  code, tile, energy/maxEnergy, stacks/manual stacks, effective stacks and
  level, group size, area multiplier, construction/upgrade progress and
  flags, spawn timer, attack timer and target; objects become views
  (accessors), as units did. A tile -> structure slot grid and a signature
  grid (owner, type, operational) kept current by O(1) writes at place,
  destroy, finish, upgrade.
- Adjacency on a helper lane (Rust): connected components of equal
  signature over the dirty region (union-find over the grid, area
  multipliers from the area table), per structure its group size and area
  multiplier; committed at a fixed tick by a parallel kernel into the
  structure columns; stats from per (owner, type, level) tables.
- Effective unit stats likewise: the kernel on a slow lane writing staged
  levels, committed at fixed ticks; stats from (owner, type, level) tables.
- Then: tower targeting and firing (brain lane + motor), barrack/spawner
  timers (motor) and spawns (records), worker effects on structures
  (deposit, build, heal, research, salvage: records resolved by a batched
  kernel on helpers).

## Combat (stage 1 design)

- Columns per unit: `cmMode` (0 none: the old path; 1 hold: stand and fire;
  2 chase: step toward the target), `cmT`/`cmTId` (target slot and id),
  `cmTB` (structure target tile or -1), `cmForced`; the order's own
  movement (flow/path arming) is left in place underneath, so dropping a
  target resumes it.
- Brain: SIM_KERNEL_COMBAT_BRAIN on lane T10, posted with the acquisition
  snapshot: per combat unit, keep a live visible target or take the
  acquisition result; in range by areas (any k, worked out there) -> hold,
  else chase; none -> mode 0 (its order resumes). Committed at a fixed tick
  by a parallel kernel (columns only).
- Motor (SIM_KERNEL_MOVE, JS and Rust): mode 1 fires when the timer is out
  and the target is alive (any style: hit record), mode 2 steps toward the
  target's pass-start position (slide on walls); both output 1/3 (moved or
  not, tile change), so the unit pass skips them.
- Objects: targetUnit/attackTarget read the columns (accessors); player
  attack orders write them.

## Stages (each keeps the game playable, with tests and a benchmark)

1. **Attack state in columns; all styles fire in the kernel.** Targets as
   slot+id columns behind the existing accessors; hold re-arm inside the
   movement kernel; ice/laser/ram/building attacks as hit records (styles
   applied by SIM_KERNEL_HITS, recoil and FX as events). Removes hold-fire
   and chase-in-range commits and most in-range Unit.update calls.
2. **Engage / target died / resume attack-move as decision records** from
   the acquisition lane (already on helpers) and a combat lane; the kernel
   applies them (command, target columns, re-arm).
3. **Effective stats on a lane** (per unit type and owner tables, lagged
   apply; user: lag is fine).
4. **Worker AI as a state machine over columns** on a worker lane (search
   tier already there): MOVING_TO / RETURNING / IDLE transitions as
   records; deposits, construction progress and salvage as kernel effects
   on building columns.
5. **Paths:** path requests as records (A* already on helpers), whole-path
   pools; flow-field arming in the kernel.
6. **Towers, barracks, spawners:** targeting on lanes, firing and spawning
   as motor kernels and records.
7. **Unit.update leaves the tick.** Kept only as a reference for tests until
   twins replace it; kernel/object equivalence becomes JS/Rust twin
   equivalence plus scenario tests.
8. Then the remaining main-thread phases (hash, separation commit,
   adjacency, visibility) toward the 50 ms budget.
