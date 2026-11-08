# Unit births in wasm, q / e off the foreground (started 2026-11-08)

Goal: q / e (resizeUnitGroup) on any selection size costs at most a few ms on
the simulation thread. All searches and per-unit passes are batch kernels on
the helpers; the tick only applies their results with flat, parallel
wasm/SIMD write loops. No per-unit JavaScript, no JavaScript fallback. The
same birth path then replaces production's per-unit spawn
(`simSpawnBatchAdd`), whose objects, slab allocator and `defineProperty`
calls cost ~5-25 us a unit.

Origin: PERF_FUZZ_SPIKES_2026-11-07.md S1 (2-5 s tick stalls).

## Measured (tests/resize-spike-probe.cjs, scenes/mixed-200k.gz, 11 helpers, Node 24)

| Version | x2 of 39k selected (39k new units) |
| --- | ---: |
| Before (per-unit JS spawn + occ_spawn ring search) | not run here; Edge fuzz: 2.3-5 s for 80-170k |
| Placement in one kernel (cell BFS), births by the spawn batch | 1032 ms (placement 370 ms) |
| Placement by r x r blocks | 424 ms (placement ~100 ms, the rest per-unit JS births) |

Per-unit JS births (Object.create, slab allocator, handle, 9 defineProperty
calls, k_slot_zero call per reused slot, template lookups) are ~8 us a unit:
5 s at 500k. Placement at ~2.5 us a unit on one thread is also too slow for
the foreground. Both go.

## Design

A new unit is its template's row copied (every unit and movement column),
then given its own: id, position (x, y, prevX/Y, x0/y0), stacks and levels,
energy, maxEnergy (from the stat table), handle, occupancy record, spatial
fields, and the per-unit pool references reset to defaults (path window,
worker and status records, object-field digest, targets). Which columns are
copied and which take their default is a static per-column table made at
match start. Group shares (stacks, levels, energy) are written by the same
pass. d2 kills are `energy = 0, dead = 1` writes (the retire pass removes
them, as now).

Tick T (action): the selection ids are copied into the resize lane's buffer
(one memcpy). Nothing else.

After tick T's end (beside the unit index prebuild, SIM_LANE_IX): a chain on
the helpers reads the frozen end-of-tick state:

1. look (chunks of ids): id -> slot, filter (owner, alive, not king), key
   (type, level); per chunk per key: count, stacks, energy.
2. plan (one job): groups in key order, keep / spawn per group within the
   population room, group starts.
3. scatter (chunks): slots into group order (id order inside a group);
   templates; templates' spatial block (16x16 tiles).
4. bucket by block (count, prefix, scatter).
5-8. placement, four block colours (blocks of a colour are two blocks
   apart, wider than the search): per block, per group, the r x r block
   multi-source search (occ.rs k_resize_place's), footprints marked in a
   planned bit plane, free = (bits | planned) clear. Positions out.
9. slots (one job): the new units' slots from the slab allocator (wasm),
   sorted by slab key; handles from the heap handle stack.

Tick T+1, before its actions: apply (parallel kernels, chunks by slab):
clone rows + own values + shares + kills; occupancy bits |= planned over
the touched rows (SIMD), planned cleared; occupancy records; id table
append (ids ascending) and id hash insert; spatial insert
(k_spawn_spatial); upkeep bins; population counts.

Unit objects become lazy: a slot with a handle but no object gets its
`Unit` object when JavaScript first asks (`SimOwners.at`).

## Staged q / e (user, 2026-11-08: no foreground hitch at all; a tick or two of delay is fine)

Measured after stage 3: x2 of 224k new units costs ~1-2 normal ticks in
the tick that applies it (225 ms vs 120-200 ms ticks), d2's retire 400 ms
the tick after. Not allowed. The CPU is saturated at this scale, so the
work must leave the applying tick entirely:

- Tick T, action: the ids copied into the lane's buffer. Nothing else.
- End of tick T (where the unit index prebuild is posted): a parallel
  snapshot of what q / e reads (per selected id: slot, key, stacks, energy,
  position, footprint, type columns), the occupancy bits and walls copied
  (map-sized), the plan (one job), the births' slabs reserved (empty and
  never-used slabs, O(births / 64); their slots stay not live, the
  allocator does not hand them out).
- During tick T+1, lane SIM_LANE_RZ: scatter, placement on the snapshot
  bits, births sorted by block and given the reserved slots in order, every
  column of every new slot written (zero, core, the template's copied
  columns), the shares planned.
- Start of tick T+2 (commit, the same tick on every peer, before its
  actions): per birth its footprint checked against the live bits and
  marked (block jobs), the shares from the births that stood (plan + flat
  write), d2's kills, births made live, id table append, id hash by CAS,
  spatial insert, footprint records, upkeep bins, handles taken as a range.
  Unused reserved slabs given back.
- Determinism: the lane reads only the snapshot and its own buffers; the
  commit tick is fixed; a resync / snapshot encode waits for the lane and
  commits a pending resize first (or encodes it).

### Status of the staged flow (2026-11-08, later)

Implemented: lane SIM_LANE_RZ (lane 14; control words shifted, 192),
_rzStart (look with the snapshot outputs, plan, scatter with the template
captures (position, footprint, type, r, collisionR, type columns into tcp),
k_rz_reserve (whole empty / new slabs, home RZ_RESERVED: the allocator skips
them, sfree 64 keeps the passes off), occupancy bits and walls copied), the
lane chain (bucket / plan / scatter / place x2 rounds on the snapshot,
k_rz_assign, zero, core rows), rzCommitDue at the tick end after the
action's tick (k_rz_cplace with an 8-cell ring retry inside the block,
k_rz_crank, k_rz_cfill, k_rz_cslabs, shares, k_rz_kill, parallel spatial
insert and upkeep bins with atomics). Buffers made and bound at match start
(rzReserve). Also fixed: the single-birth allocator grew the columns when a
new slab would pass the cap even with free holes (177 ms in a production
spawn after a d2).

Fixed since (all found at chaos-1m-250k / by the determinism suites):
- The tick after an x2 commit took ~800 ms in unitEventsRun: every new
  unit carried a UNIT_EV_SPATIAL event the movement had written into its
  reserved (not live) slot during the wait tick (k_unit_events clears only
  live units' events). k_rz_cfill clears mvEv. After: 184 ms first x2
  (cold), 96 ms second, against 110-230 ms normal ticks.
- Host with helpers diverged from guests without (tick ~338): the lane's
  zeroing and core writes changed reserved slots while the tick ran, and
  stale references to their last (dead) units read them. The lane now
  zeroes only columns no stale reference reads (_rzZeroTable: not the
  core, live, tmOn); the core (id, owner, position, r, dead, dead0, energy)
  is written at the commit (k_spawn_write, parallel). Determinism suite
  passes with 0 and 4 host helpers; checkerboard 3/0/2 helpers passes (524
  clean comparisons).
- Births capped by whole empty slabs (151k of 223k): k_rz_reserve now takes
  free slots: empty slabs, then holes of partly free slabs, then new slabs;
  k_rz_cslabs gives each slab's unused ones back (free count, home kept).
- The commit's footprint check moves a birth whose spot was taken during
  the wait to the nearest free cell within 8 cells inside its block (99.8%
  stood at chaos-1m).
- The occupancy's expectedBits (checkerboard's "collision occupancy").
- A pending job in snapshots (rzSnapshot / rzRestore, by ids; the restoring
  peer reserves its own slots and re-runs the rows (k_rz_rows) and the
  zeroing; restored after the decode's slot layout and occupancy rebuild).
  A birth's copied type columns are its group's first template's (what a
  snapshot carries per group). tests/unit-resize-staged-snapshot.test.cjs.

Then (2026-11-08, "both"):
- The commit spread over ticks: from the due tick (now the end of the tick
  after next: the lane always has a whole tick), RZ_COMMIT_PARTS (4)
  sub-commits by block, one a tick (footprints checked and claimed, the
  part's units live, their spatial entries and upkeep bins), then the final
  step (newl by group, shares, d2's kills, the reserved slots' books). A
  part's round-0 and round-1 blocks run as separate jobs (they overlap).
  k_spawn_write takes a row offset (P[7]).
- Snapshots carry a job in its commit steps (the parts, the births made so
  far by unit id, the plan's spawns); a restore before or in the commit is
  tested (unit-resize-staged-snapshot, two cases).
- Found and fixed on the way: (1) a decode kept the peer's own pending
  job's slot reservation (books kept when the layout is unchanged) and the
  restore reserved again: rzCancel at every decode's start; (2) units dying
  inside a partly reserved slab: their freed bits were overwritten by the
  final slab step (now merged); (3) the slot relayout rebuilt the books
  while slots were reserved (it waits while rzHoldsSlots: peer-local).
- Retire pass: simUnitStateDetachGone per removed slot (~20 calls each)
  replaced by simUnitStateDetachGoneMany: a tight JavaScript loop only for
  what is JavaScript (an object that exists: its gone record; the pending
  path list; the two references kept by handle) and one kernel for the
  rest (nfs.rs k_retire_release: handles, the free queue, worker and status
  records, the pooled reference / object fields). The worker pool's free
  stack is in the heap now. No object is made for a lazily born unit.

Open:
- k_unit_gone (the retire's kernel) is serial: ~13-25 ms at ~170k deaths.
- The action tick's look + scatter + id cleanup (~20-30 ms warm at 239k
  selected): move look / scatter into the lane on a snapshot of the
  selected units' columns, or shrink.
- Worker subgroups make no new units on x2 (worker records in wasm).
- Two peers with different histories restored from one snapshot diverge
  even without q / e (found while writing the snapshot test): a restore
  bug, pre-existing.
- Memory: ~270 B per reserved selection entry (the 96-byte row buffer
  first).

## Stages

| # | Stage | Status |
| --- | --- | --- |
| 1 | Lazy unit objects (SimOwners.at makes them; UnitIdIndex checks handles, not objects) | done |
| 2 | Handle stack in the heap; slab allocator in Rust (nfs.rs k_slab_take, slab_alloc_bulk), single births call it too; JS allocator removed | done |
| 3 | q / e as parallel batch kernels (birth.rs): look, plan, scatter (d2 kills), block placement (fit maps + bit-parallel ring search, two rounds), k_birth_take (slots, handles, ids, rows, footprints, id tables), k_slot_zero, k_spawn_write, k_rz_shares (closed-form water fill), k_spawn_spatial, k_upk_bins | done, foreground parallel |
| 4 | No column growth in q / e: births bounded by the reserved slots (_rzSlotRoom) | done |
| 4b | No stat programs and no JavaScript first unit per group: a birth copies its template's type columns (RZ_COPY_COLUMNS, birth.rs k_birth_fill), the shares kernel writes levels / rows / maxEnergy / energy | done |
| 4c | Id order deterministic (the old per-group JS first unit depended on the peer's template cache: ids 198/199 swapped on a repaired guest, found by multiplayer-chaos-determinism) | fixed by 4b |
| 5 | Worker subgroups: worker records / task fields in wasm (x2 on a worker subgroup makes none yet: k_rz_scatter skips worker templates) | open, next |
| 6 | k_birth_take split: k_birth_alloc (serial: slots, handles) + k_birth_fill (parallel: rows, footprints, handle table, id table rows, id hash by compare-exchange) | done |
| 6b | Parallel spatial insert (k_spawn_spatial is serial) | open |
| 6c | Helper binding stalls: a rebind right before a parallel job leaves it to the simulation thread (helpers get bindings by message); resize uses its own names now (rz.*); a shared-memory pointer table would remove the class | open |
| 6d | Freed slots zeroed on a background lane before they return to the free lists (births then never zero) | open |
| 7 | Search stages to a between-ticks lane if the foreground is still above a few ms | open |
| 8 | Production spawns through the same birth kernels; remove simSpawnUnit / simSpawnBatchAdd per-unit paths | open |
| 9 | Retire pass (d2's 200k+ kills): per-unit JS detach -> kernel | open |

Note: dead units' JS reference fields and object fields are now released at
death (simUnitStateDetachGone), so a kernel birth into a reused slot needs
only k_slot_zero. Batch births prefer whole empty / never-used slabs
(streaming writes, nothing to zero for never-used ones).

## Measurements after stage 3 (Node 24, 11 helpers)

| Case | Before | Now |
| --- | ---: | ---: |
| mixed-200k, x2 of 39k selected | 1032 ms (interim kernel) / 2-5 s Edge | 66-76 ms (first, cold bindings), 35-58 ms after |
| chaos-1m, x2 of 239k selected (223k new) | - | 532 ms incl. a 202 ms column growth (since removed) |

Stage times at 223k births (ms): placement 30, k_birth_take 38, k_spawn_write
44, k_spawn_spatial 23, shares 32 (serial, since made parallel), k_slot_zero
16, k_uid_clean 11 (action preparation), look 7.
