# Memory traffic implementation

Requested scope: implement the complete memory plan, with Float32 gameplay
quantities and deterministic multiplayer. The user asked for one
implementation pass first, then benchmarks, then fixing differences.

## Baseline

400,000 initial units (tests/200000-1000.json), ACTIVE=1 BATTLE=mix,
HELPERS=7, host + guest, 100 measured ticks: mean 117.52 ms, p50 108.58 ms,
p95 202.64 ms, zero desyncs. Raw output: `.claude/memory-baseline-400k.log`.
One run, not the full requested benchmark matrix.

Command: `DATA=tests/200000-1000.json HELPERS=7 ACTIVE=1 BATTLE=mix TOPPHASES=1 node --max-old-space-size=12000 .claude/tickbench.cjs 5`

## Implemented

Storage (834 -> 553 bytes per unit slot, `node tests/storage-abi.test.cjs`):
- Float32 unit quantity columns (positions, velocities, radii, energy,
  timers, levels, movement/combat/worker/separation geometry), Int32
  pathIndex and worker deadlines (`_simTickBound`: same `t < bound` answer
  for every integer tick; NaN never, Infinity always).
- Duplicate `mvHTT` and declaration-only `mvHOT`/`mvHOZ` removed; `mvStepT`
  removed (job-local `_simMoveDone` flags, see below).
- Rust storage adapters (`F32`, `I32Number` in lib.rs) keep double
  intermediates and round at stores; shared stats rounded to f32 at the
  precomputed-stat tables (data_dynamic.js `_simF32Stats`).
- Explicit-path window pool (`mvPath` handle, `mvNodes` pool of 16-node
  windows): only path movers hold one; released on path change and on
  detach (`simUnitStateDetach`).
- `SIM_UNIT_SCHEMA` (type, count, bytes, group, default, snapshot) built
  once, duplicate declarations throw; `simMemoryStats()` reports bytes per
  slot, capacity, path windows, bound bytes per array group and the wasm
  heap. `tests/storage-abi.test.cjs` checks every unit column the Rust
  movement kernel reads has the element type the JS column is allocated with.

Passes:
- MOVE_STEP fused into MOVE: one scheduled job per slot range runs the
  committed-step fast path, then the general passes; the step-done flags are
  job-local (JS `_simMoveDone`, Rust: bytes from word 300 of the thread's
  argument block, base slot at word 299; chunks are 512 slots).
- Store only on change: status kernel (stEv/stAcc writes only for affected
  units; EV is 0 between passes), laser hits' event clear, movement's
  mvFire clear and dead0 copy (JS and Rust).
- Worker search requests: count, prefix, then fill compact payloads for due
  requests only (WS_SELECT P[5] 1/2).
- Scratch pools sized `simReserveCap(n)` (+12.5%, 4096 blocks) instead of
  doubling: unit index entries/keys/merge, acquisition snapshot and
  entries, hits, status list, movement post/hit lists, visibility sources.

Copies / presentation:
- Acquisition coordinates, entries, visibility cover (Uint8 "visible"),
  healer candidates, worker search payloads, separation overlap/next
  position, frame inputs, combat FX, presentation motion snapshots and
  scratch: Float32 (or narrower ints).
- Presentation motion snapshots (16 bytes/unit instead of 32) published
  only when the presentation worker asked (ctl[1]: set when it takes the
  newest snapshot or finds it older than the tick it draws, which it then
  skips; a newer one is drawn as before).
- Presentation metadata copied into a frame buffer only when its revision
  moved (bumped on a slot's new unit and at each metadata cycle's end).

Compatibility:
- `SIM_RULES_REVISION` (utils_snapshot.js, 2): sent in LOBBY_JOIN (host
  refuses a mismatch before the join), START_GAME (guest refuses), and
  snapshots (`rules`; a snapshot of other rules is refused, one without
  rules — older saves — is normalized by the Float32 column stores).
- Script cache versions bumped (`?v=20261008-mem`).

## Fixes made in this pass (incomplete edits from the previous session)

- Movement still read `unit.mvStepT` (JS flow step and pre pass; the Rust
  argument word 4 was already `mvPath`): now `_simMoveDone`; word 4 is
  `unit.mvPath` in `_SIM_MOVE_WNAMES`.
- Presentation snapshot `y` and `px` shared an offset (`8 + cap * 8`): `y`
  is at `8 + cap * 4`.
- Detached units kept their path window: released in the detach.
- wasm-kernels test still made `acq.cover` Int32 (now Uint8, as the game).

## Second pass (high-traffic columns)

- owner and spOwner Int8, commandState and attackFlash Uint8 (Rust adapters
  `I8I32`, `U8I32`: read and written as i32); acquisition snapshot's own/cmd
  Int8/Uint8. 553 -> 542 bytes per slot (tmOn added below).
- `tmOn`: attack timer, attack flash and worker transfer cooldown counted
  down only for flagged units (set by their setters and by the movement
  kernels' attacks, JS and Rust; cleared when all three are out).
- Presentation worker reads the seven status timers (and `watched` for the
  light) only for units with `stOn`.

## Results (400k, ACTIVE+BATTLE, HELPERS=7, 100 ticks, one run each)

| run | mean | p50 | p95 | simMoveRun | separation | desyncs |
|---|---|---|---|---|---|---|
| baseline | 117.5 | 108.6 | 202.6 | 21.6 | 7.3 | 0 |
| first pass (`memory-after2-400k.log`) | 106.3 | 96.6 | 164.7 | 18.3 | 6.4 | 0 |
| + narrowing, tmOn (`memory-after3-400k.log`) | 105.7 | 96.9 | 194.2 | 17.2 | 6.7 | 0 |

The first pass is -9.5% mean / -11% p50; the second pass is within noise
(simMoveRun -1 ms; p95 is single spikes). Wasm heap (host) 1925 -> 1352 MB.
The first benchmark (`memory-after-400k.log`, 111.8 ms) had the visibility
seed moved to the foreground (+2.5 ms): restored to the background job on a
Float32 snapshot.

## Validation

- Fixed after benchmarking: kernel step positions are rounded to Float32
  before tile checks and quantization (`Math.fround(x + vx)`, Rust
  `as f32 as f64`), as the object path's column store does (equivalence
  failed at seed 5 islands tick 242 before).
- Passing: storage-abi, wasm-kernels (6 seeds), kernel-object-equivalence
  (4 cases), and round 0 of the determinism suite: chaos, cross-engine,
  corruption-fuzz, action-fuzz, late-seal, scenarios, host-migration,
  extremes, snapshot, matrix, patch, border-combat, shared-spatial-*,
  shared-kernel-threads, shared-frame-ownership, sim-frame-replica.
- Test fixtures updated for Float32 storage: shared-unit-state (precision
  expectation), parallel-kernels (reference overlap Float32),
  shared-separation-commit (ov/nextX/nextY Float32), wasm-kernels
  (acq.cover Uint8, owners Int8, commands Uint8).
- multiplayer-desync-recovery fails ("mine: repair took 4500") — the same
  failure at HEAD without these changes: pre-existing.
- Not yet run: the 5-round suite to completion, CHAOS_SIM_EVAL threshold-0
  variants, Edge (render/visibility modes), 800k and the helper-count matrix.

## Third pass (compute, unit pass)

- Object area-range checks (`isWorldTargetWithinAreaRange`, ~1,300 a tick)
  use the kernels' twin (`simAreaRangeFast`: flat area grid + CSR graph, up
  to 2 steps), general path above: unit pass 30.4 -> 26.0 ms.
- Drive-by look (JS + Rust): candidates listed (up to 64) and range-checked
  nearest first; Rust scans owner masks 8 cells at a time (u64 SWAR); the
  structure search skips blocks with no hostile structure. Same answers
  (kernel/object equivalence, drive-by test, host wasm vs guest JS lockstep:
  0 desyncs). Wall time stayed ~4 ms: the look's cost is elsewhere (it is
  58 ms CPU without helpers, the largest kernel by CPU); left for later.
- Tried and removed: a per-tick packed entry table for the looks (0.9 ms to
  build, more than it saved).
- 400k ACTIVE+BATTLE: mean ~100 ms, p50 ~91 ms (from 105.7 / 96.9).
- KTIME in tickbench counts setup ticks too: use KTIMETICK for kernel walls.

Next: BRAIN_OFF_MAIN_THREAD_PLAN.md (the user's direction: only motor
kernels on the main thread, every decision on helper lanes).

## Continued in BRAIN_OFF_MAIN_THREAD_PLAN.md

From 2026-10-08 the work follows the user's direction: no brains on the
main thread (motor kernels only, decisions on helper lanes). Progress,
results and next steps are kept there; 400k mean is 76.6 ms (p50 69.7).

## Remaining column candidates (by likely traffic, every unit every tick)

1. x0/y0 pass-start copy (16 B/unit/tick through ix.slots) and prevX/prevY
   (written by every mover): double-buffered positions or prevX == x0 for
   movers would remove a copy; needs the meaning of prevX for units moved
   by separation/objects checked first.
2. Presentation per frame: owner/energy/r/cmd/levels/flash/flags copied for
   every unit every frame (~25 B/unit); copy only changed slots or by
   revision like the metadata.
3. Separation finish per slot: spEpoch/vsGen (Int32 equality stamps),
   spTile/spArea, sepCx/sepCy: stamps could be one Uint8 "index current"
   flag maintained by the index rebuild.
4. Movement pre pass per slot: mvOn/mvOut/mvFlags/energy/sepKey/dead/fire
   are separate byte/word columns read for every slot; packing mvOn+mvOut+
   mvFlags+dead (same writer: the movement kernel and setters) into one word
   halves the lines touched. Path-only fields (mvBase/mvPlen/mvScan/mvWlen,
   13 B) belong in the path window pool.
5. Status kernel: stAcc is still read for every live unit (report check);
   a pending-DoT bit in stOn would skip it.
Low traffic (subset-only, footprint): worker ws*/wk* (~84 B), forced-target
fLs* (20 B), hold/chase mvH*/mvChs (24 B), drive-by db* (16 B), nav look
cache mvNav* (33 B, flow movers): sidecars.

## Not done (with reasons)

- Worker/forced-target sidecars: ~104 bytes/slot of footprint, but these
  columns are read only for workers / forced targets (no traffic for other
  units); every JS and Rust accessor would index through a pool. Deferred.
- Owner Int16 / command Uint8: 5 bytes/slot; read as i32 by several Rust
  kernels (separation, movement). Deferred.
- Acquisition entries built directly from source columns: the pack runs on
  the tier lane after the tick-start positions change; needs the pack moved
  to the foreground post and the Rust scan to read entries only. Deferred.
- Changed-slot lists for spatial counts: SP_COUNTS reads one byte per slot
  already (mvOwn); little to gain.
- Regional hash slot lists: not started.

## Remaining

Benchmark matrix (400k/800k; idle, moving, active, mixed; helpers 0/3/7;
Edge in three visibility modes), then the full validation pass
(determinism suite, equivalence, late join/patch/host migration).
