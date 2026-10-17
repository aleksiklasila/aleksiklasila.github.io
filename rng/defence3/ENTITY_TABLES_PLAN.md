# Entities as tables (units, buildings, floor items, mines, projectiles)

Decided by the user on 2026-10-18 (ADAPTIVE_SIMULATION_AT_HIGH_SIMULATION_COST.md
A3, pushed further): units and buildings are rows of data tables (type,
position, levels, energy, timers, targets...) and nothing else. No per-entity
JavaScript objects in the simulation; no legacy object paths kept. Large
refactors are fine. Columns are structure-of-arrays, narrow types, laid out
for wide SIMD in the Rust kernels. Correctness bar: the determinism suites
pass (not bit-identical trajectories); small divergences found mid-refactor
are logged below and fixed in a second pass, unless they block the refactor.

## Why

Measured at 2M units / 200k buildings (Edge, 2026-10-17/18):

| per entity | before | after the first slimming |
|---|---|---|
| unit wasm columns | 614 B | 515 B |
| unit JS object (+ arrays it adds) | ~1.35 KB | ~0.77 KB |
| building JS object (+ strings, arrays) | ~1.7-2.9 KB | ~1.5 KB |

The worker's V8 heap (~4 GB per isolate) and the 4 GiB wasm heap cap the
population: 4M units needed ~5 GB of unit objects, 8M ~10 GB. Objects also
cost GC marking per entity and keep logic out of SIMD kernels.

## Target

- **Handles are integers.** A unit is its slot (kernels) or id (state,
  snapshots, commands; id -> slot via the slot map). A building is its slot
  in the structure table (tile index stays its position column).
- **All state in columns.** Numbers in typed columns (wasm heap when a kernel
  reads them, JS-side typed arrays otherwise); flags packed; strings as type
  or table indexes; references as ids/slots; rare per-role state in sparse
  side tables (worker records, sim_unit_state.js SIM_UNIT_WK_SIDE).
- **Logic over slots.** Unit/structure methods become functions of a slot;
  lists of entities are slot ranges or packed slot lists; selection and UI
  hold ids.

## Passes

1. **T1 data into tables** (units, then buildings/floor items/mines,
   projectiles): every field moves to a column or side table; the object
   keeps only its slot (a handle while code is converted). Shared derived
   data (stats tables) referenced by row index.
2. **T2 references as ids**: target, worker target, attack target, rally
   targets, projectile source/target, healer candidates, spatial buckets,
   selection, events: ids or slots, not objects.
3. **T3 no objects**: `units`/structure lists become slot lists; methods
   become slot functions; the handle classes go. Page-only simulation (no
   worker) uses the same tables.
4. **Second pass**: fix logged divergences; rerun the determinism suites and
   the 2M/4M/8M Edge loads.

## Divergences and failures logged (fix in the second pass)

- multiplayer-chaos-determinism (crossroads, after the scout-target and unit
  slimming changes): the first forced divergence (boss 68, tick 273, guest2)
  shows hash mismatches but no patch is requested until tick 563 (after the
  second one): a detection/repair gap. The test now skips forced divergences
  no hash showed (dead with their unit); this one is shown and still fails.
- research-queue.test.cjs, unit-hidden-class.test.cjs: fail at the committed
  revision too (UI panel rows; the large-battle bench's sandbox lacks
  `location`).

## Progress

- 2026-10-18: unit columns 614 -> 515 B (Uint16 status timers; worker records
  pool); Unit objects 944 -> 368 B (role memory object, type constants as
  getters); building stats signature string -> numbers; scouts head for a
  32x32 grid of shared destinations (100k flow fields at 2M -> 1k).
