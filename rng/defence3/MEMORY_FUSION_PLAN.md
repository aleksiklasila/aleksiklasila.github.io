# Memory diet and fusion of the per-step sweeps (2026-11-13)

User's direction: no serial foreground; fuse passes that read the same data (memory, not arithmetic, is the
bound); no two parallel kernels sharing tables they write (false sharing: fuse instead); fewer bytes per unit
(remove, narrow, bit-pack, lower precision); flip buffers instead of snapshot copies. Occupancy (kernel 89) gets
its own session.

## Data (chaos-1m-250k, dk 4, after 25 steps: 1.15M slots, 1.0M listed, 354k live)

Tools in tests/test-runs/bg-10x-20261113/:
- `colcensus.cjs`: every unit column's bytes a slot, its value range over live slots (min, max, whole numbers,
  distinct values, share at the most common value) and the kernels that name it; times PV_MARKS.
- `colbytes.cjs`: per kernel the unit columns it names and their bytes a slot; columns shared by 3+ kernels.
- `order-driver.cjs`: one step's parallel jobs in order (kernel, chunks, wall, caller).
- `pvcheck.cjs`: PV_MARKS outputs hashed + timed (build A/B).

Unit columns: **790 bytes a slot**. Largest: mvNav 32 (flow-look record, 8 x i32), mvSteer 32 (steer record,
8 x i32), hg 16 (handles' generations), then ~150 four-byte columns.

Per-slot sweeps a step (bytes a slot their arguments name; wall at 8 helpers):

| kernel | B a slot | wall ms | notes |
|---|---|---|---|
| STATUS 24 | 104 | 2.4 | skip test reads stIx (4 B) + timer flag + live + dead + energy (4 B); bulk step-start copies x0/y0, separation's dead / layer / radius |
| EFF_UNITS 27 | 83 | 1.9 | due units by index order |
| WS_SELECT 45 | 65 | <1.6 | one sweep since 2026-11-13 (was two) |
| PV_MARKS 85 | 64 | 3.4-5.2 -> ~2 | browser only; empty-slot skip + 4 lanes 2026-11-13 |
| ACQ_SNAP 32 | 53 | 3.7 | writes ~48 B a slot of copies |
| MOVE_OCCUPANCY 89 | 49 | 34 | own session |
| VIS_SNAP 30 | 24 | 3.1 | |

Columns read by several of those kernels each step: dead (10 kernels), x / y (8), owner (8), live (5), stIx (5),
sepKey (5), energy (4), id (4), statRow (4), x0 / y0 (3), commandState (3), prevX / prevY (3), mvOut (3).

Constant over all live units in this scene (each to be checked: dead, or used only elsewhere): mvBase, mvPlen,
mvScan, mvPath (-1), rsEnd (-1), navRdy, agWait, ptVer, mvFGen, mvReady, mvHTId, sepCx, sepIv, sepCv, lzAcc,
lzBeam, tuS / tuId / tbT (attack orders), hAcc, hSx, ordSq, stAc, mvOut, mvSpent, mvWlen, vsGen, pvAt (0: no
presentation in Node), spEpoch, fLsX / fLsY, j__damageFlashStart / Until / Strength (flashes off), j__rslot,
j__okTile / okVer / okNodeTile / okNodeVer, j__effectiveStatsStamp, esOk.

## Stages

1. **Sweeps that can skip cheaply** (outcome-identical): PV_MARKS done (empty-slot fast path: live / dead / pvS
   only; 4 lanes for live slots: 25-30 -> 12-17 ms single-threaded). Next: STATUS's skip from one byte a slot
   (a "status or timer running" bit kept by its writers) instead of stIx + energy; per-slab activity bits.
2. **Rare-feature columns to sparse records**: the constant columns above are mostly not dead but used by rare
   cases (mvBase / mvPlen / mvScan / mvWlen / mvPath: units following an explicit path, mv.rs move_path; lzAcc /
   lzBeam: lasers; tuS / tuId / tbT: attack orders; mvHT / mvHTId: chases; sepCx / sepIv / sepCv: separation
   carries). They cost residency and every per-unit copy (births, slot moves: 790 B a moved unit, slot resets),
   little per-step traffic: move each feature's columns to a side table indexed by the units that have it (as the
   worker and status records are). Truly unused ones (j__damageFlash* with flashes off, j__ok*, j__rslot,
   j__effectiveStatsStamp: check) removed. Target: -100 B a slot or more.
3. **Hot state word**: live, dead, owner, commandState, mvOn, attackFlash, timer flag, worker flag... in one u32 a
   slot (bit-packed), read by every sweep instead of 6-10 byte columns; writers through one helper (JS) / inline
   (Rust).
4. **Records packed**: mvNav 32 -> 12-16 B (tiles 20 bits, next tiles as 2-bit directions, far tile, versions
   narrowed), mvSteer 32 -> 16 B; positions: x0 / y0 by a flip (two buffers, the step's parity) where readers
   allow it, prevX / prevY merged with them where equal.
5. **Fused step sweeps**: the step-start per-slot passes (statuses + visibility snapshot + presentation marks +
   worker select count) as one kernel over slab runs reading each slot's hot word and positions once; then the
   post-movement ones (flow-look listing + spatial counts + traffic capture) with the movement's epilogue.
6. **False sharing**: no two kernels of one stage writing the same lines (per-job outputs on separate 128-byte
   lines, as the stage entries' parameter areas are); checked per stage.

## Status 2026-11-14

- Stage 1: VIS_SNAP in vectors (2.0 -> 1.0 ms), STATUS without the dead separation copies (1.7 -> 1.4).
- Stage 5 (first part): ACQ_COMMIT + COMBAT_COMMIT fused into ACQ_SNAP (4.2 -> 3.6 ms, two jobs fewer).
- Stage 2: damage-flash columns removed (12 B a slot + a JS array). Rare-feature columns to sparse records: open.
- Stages 3-4 (hot word, mvNav / mvSteer packing): the per-slot sweeps read byte columns already (a hot word saves little
  bandwidth there); the gain is in kernels 8 / 89 random reads, which the occupancy plan owns.
- Measured: ACQ_SNAP / EFF_UNITS / WS_SELECT memory-bound (1.4-1.6x from 3 to 9 threads); VIS_SNAP was compute-bound.
