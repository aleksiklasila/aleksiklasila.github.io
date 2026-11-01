# Units and structures as tables (no simulation objects)

Direction from the user (2026-11-01): a unit or a structure is its row in the
tables; spawning, production, queues, rally and stats are table writes and
wasm passes; rendering reads the same tables. No object is built for a unit or
a structure; where JavaScript still needs one it gets a lazy handle over the
row, until that code is converted too. A spawn should cost tens of ns, not
tens of us. Work is ranked by measured cost in real Edge (the 1M/250k chaos
scene, `tests/scenes/chaos-1m-250k.gz`), not by how much work it is.

## Where the step time is (Edge, chaos scene, ~230k units / 287k structures, dk=1, ~450-600 ms a step)

Simulation worker main thread, ms a step (profile p6, 2026-11-01 night):

| phase | ms/step | notes |
|---|---|---|
| movement (`simMoveRun` + its kernels, `simParallelRun`) | ~170 | kernels on helpers, waits included |
| `unitEventsRun` | ~78 | kernel events applied in JS |
| `simRustDirect` (other kernels on this thread) | ~77 | |
| `processGlobalSpawnerQueue` (spawning ~1.1k units a step) | ~53 | was ~125 before today's spawn work |
| `simPresentationPump` | ~44 | of it `_simWriteStructure` ~28: structure objects copied into the table every step |
| `workerSearchTierStep` | ~43 | |
| `_simPostResult` | ~20 | |

## Stages

Units:
- U1 (done, 2026-11-01): `simSpawnUnit` (unit.js): a new unit is its slot and its own columns written directly (the constructor wrote ~100 fields through setters, 81 of them the slot's defaults); fresh slots get no per-slot reset (JS-field defaults filled when columns grow); its stat columns copied from a per (owner, type, level, worker) template of what the level scaling writes (13-16 columns). `tests/unit-spawn-columns.test.cjs`: every column equal to the constructor's, the copied ones too. Spawn ~68 -> ~20 us; processGlobalSpawnerQueue ~125 -> ~40 ms a step. Type stored once (upT canonical, unitType an accessor). Determinism: a slot is not clean when taken (kernel target leftovers, JavaScript fields after k_slot_zero): see the progress log.
- U2: fold the per-unit copies (type: done), the slot reset at release in k_slot_zero (JavaScript fields as heap columns), `r`/`collisionR` from the type table (JS getters and the Rust kernels), one level column (`unitLevel` = `baseLevel`), stacks derived, the movement values of a stat row (`mvLane`, `mvReachD/A`, `mvShoot`, `mvRangeK`, `lzFlags`, `maxE`) read from the row in the kernels, the stat object references (`preComputedBase`, `basePreComputed`) by row.
- U3: spawn as a batch: a step's spawns (row, type, level, exit) written in one typed pass (slot claim, columns, id table, occupancy, spatial index), in wasm; no handle object; a lazy handle (`simUnitObj(slot)`) for the JS that still asks.
- U4: the remaining JS consumers of unit objects (`S.owners[]`, `units` iteration, object references in targets and orders) to slots, by measured cost.

Structures:
- S1: (found 2026-11-02: a structure's fields are already columns of its class's table, data_state.js `_sTables`, the object a handle over its row `_sr`; production state, `_qN`/`_qLv`/`_qReq`/`_qPaid`, is columns, event-driven.) The presentation structure table (SIM_STRUCT_SPEC) is still filled by copying every structure's ~45 fields through accessors (`_simWriteStructure`, the metadata sweep and tile changes, ~28 ms a step): written by the column setters on change instead, or the page reading the class tables' columns, so no per-step sweep.
- S2: production (`updateSpawnerProductionProgress`, ready order, `processGlobalSpawnerQueue`) as one wasm pass over the rows, emitting the step's spawn batch (U3).
- S3: towers, upgrades/stacking, salvage, research labs, construction on the rows; placement and removal as row writes.
- S4: the remaining structure objects (adjacency, worker targets, cell items) to rows; lazy handles until then.

Each stage: measure in Edge (profile + `?simtrace=1`), keep peers deterministic (two-peer chaos runs, `tests/multiplayer-chaos-determinism.test.cjs`), then the tests.
