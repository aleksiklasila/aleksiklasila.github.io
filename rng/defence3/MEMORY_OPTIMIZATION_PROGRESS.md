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

## 4M units in the 32-bit heap (2026-10-25)

Decision: the 32-bit kernels stay the default for the game and the tests (memory64: V8 bounds-checks every access
explicitly, ~10% of a tick at 200k, the movement kernel +26%, Node 24 and Edge 155 alike; tests/test-runs/node24-wasm64-20261025).
So big matches must fit 4 GiB: shrink memory (SoA, packing, narrower types, sparse records, shared slots by unit kind),
cache layout kept in mind where kernels read fields together. Tests run on Node 24 (nvm 24.22.1); WASM64=1 / ?wasm64=1 opt in.

Measure: `node --max-old-space-size=12000 --expose-gc tests/checkerboard-tps.bench.cjs --memory-inventory --ticks=3 --warmup=2`
(4M units, 125k towers, 1000x1000), `SIM_HEAP_SITES=1` adds the biggest live call sites at each heap peak
(`inventory.peaks`). Per-column value stats: tests/test-runs/memory-4m-20261025/colplan.cjs over tickbench AFTERALL dumps.

| step | live MB | peak MB | heap MB | unit B/slot |
|---|---|---|---|---|
| start (64-bit only: did not fit 32-bit) | 3670 (end) | 5822 | 7059 | 525 |
| reserve with slab slack (no growth copies at the start) | 3532 | 3653 | 4096 | 525 |
| cut 1 (below) | 3249 | 3400 | 4053 | 463 |
| cut 2 (below) | 3185 | 3337 | 3964 | 459 |

Final simulation hash identical throughout (cd88b396).

Cut 1:
- Reservation counted no room for the slabs' allowed holes: a starting army a few percent past it grew every column by
  1/8 with old and new copies held at once (sim_unit_state.js simUnitStateReserve).
- Levels (unitLevel, baseLevel, effectiveLevel, _lastAppliedEffectiveLevel) Int8, 0 not set (NaN stores as 0; accessors read
  undefined): k_eff_units, k_upkeep, k_snap_units (gi8), k_pv_marks, main.js _upkUnitBin, presentation level copy.
- esRad Uint8, esType Int8, vsA Int8.
- Dead columns removed (written or loaded, read by nothing): mvHWin, mvHTT, mvHVer, fLsPX, fLsPY, fLsT, cbT, cbTId (32 B).
  Tool: the movement kernel's struct fields with no use (scratchpad mvunused.cjs logic: `.field` count in wasm/src).
- Presentation marks: pvId/pvE/pvO/pvC/pvL/pvV (13 B) -> pvS, a 32-bit signature (bit 31: moved), k_pv_marks.
- Acquisition sampling: no per-entry owner / id copies (acq.saOwner, acq.saId): the bucket is the owner's, the id the slot's.
- Structure tables (data_state.js): number kinds f (Float32), i/s/c (Int32/16/8, undefined = the type's lowest value) for
  tiles, list places, stacks, levels, owners, timers, tick damages, angles; and rows reused: a structure leaving the world
  (clearTileEntity / setTileEntity replacing it) moves its values into its record (_sdet) and gives its row back
  (structRowDetach; placed again: structRowAttach). Rows used to grow for good in a long match. Test:
  tests/structure-row-reuse.test.cjs.

Still per unit at 4M (cut 1): columns 463 B/slot (~1.97 GB at 4.25M slots), unit-sized work arrays ~229 B/unit (877 MB).
Next candidates (bytes per unit):
- Lists sized for every unit (ev.list, st.list, retire.list, hit.tlist/wlist, mv.post, mv.hita/hitt, occ.work, mv.lookc:
  ~40 B): share by phase (needs the tick's lifetimes) or grow on demand with an overflow path in the kernels.
- Hit accumulators hAcc/hTouch/hSty/hBurnD/hPoiD/hWatchK (18 B, live only in the hits phase): share with other per-tick scratch.
- Status: 8 u16 timers + 3 f32 tick damages + stAcc/stDot (36 B) for units mostly not affected: a sparse record.
- prevX/prevY vs x0/y0 (8 B), sepCx/sepCy as i16 halves like sepIv (4 B), r/collisionR/sepR0/maxE from the stat row (16 B),
  mvNav's 8 words (32 B) with narrower version words.
- occ.rec (17 B), ixd room arrays (Float64 keys), vt.x/vt.y copies.

Cut 2:
- One shared slot list for st.list, ev.list, retire.list (sim_unit_state.js simPhaseList): filled one after another in
  _gameTickBody, each used up before the next (status pre-pass, unit events, dead units).
- Visibility snapshot vt.x + vt.y -> vt.p: the tile << 4 and where in it (k.rs vis_tile_of); the seed decodes it.
- sepCx / sepCy (Float32 x2) -> sepCx as i16 halves (mv.rs iv_pack / iv_unpack, as sepIv).
- Build pitfall: an integer % or / in Rust adds a panic location (a data segment): the 32-bit build refuses it
  (wasm/build.cjs). Use idiv / irem (lib.rs). The 64-bit build did not trip on it; check both builds' 'wrote' lines.
- Timing: no regression. HEAD vs working tree alternating (100000-1000 ACTIVE=1, 7 helpers): p50 48.8-50.8 vs 46.1-48.5 ms,
  mean 93-94 vs 48-50 (HEAD's growth spikes). A python3.13 process on this machine uses a core all the time and Firefox ~0.8:
  absolute numbers drift between runs; compare alternating runs only.

Cut 3 (sparse status records):
- The seven status timers, three tick damages, the unreported damage over time and the status pre-pass's report (event,
  amount) are a pool of records (sim_unit_state.js SIM_UNIT_ST_SIDE, stTh..stEv), unit.stIx the slot's (0 none; record 0
  holds zeros, never written, so readers index without a test). Replaces stOn, stAcc, stEv, stDot and the ten status
  columns: 459 -> 427 B/slot, plus ~35 B per unit with a status.
- Taken at the first write of anything but 0: JS accessors (simUnitSt), the hits apply kernel and the movement kernel's
  floor traps on the helpers (lib.rs st_take: compare-exchange pop of the free stack, else a bump of the next-record word;
  st.hdr / st.free). Given back by SIM_KERNEL_STATUS (st_give, an atomic push) once the timers are out, the damage reported
  and nothing shown this pass, and at a slot's detach. A phase only takes or only gives back, so one atomic word suffices.
- Room is made before each helper phase that takes (simUnitStReserve): the hits apply one per listed target; the movement
  kernel one per unit in a chunk with a kernel trap (kinds 1-5) or beside one (unit.js _simTrapUnitsBound, from the
  spatial counts; floor checks happen where a unit stood at the tick's start, or a tile on after the occupancy's swaps).
  A take that still finds no room is counted (st.hdr[3]), warned by simUnitStSettle, and the floor trap falls back to the
  main thread (EV_FLOOR). Reserve at a start/restore: a sixteenth of the units.
- Gameplay change (deliberate, both builds and every peer alike): a unit's tick damages (burn/poison/ice) are dropped with
  its record, i.e. once all its timers are out and its damage is reported. Before, a stale burnTickDamage stayed for good
  and was the floor of the next burn's max(). Done first on the dense layout (stOn = "would hold a record", the release
  zeroing the damages): BATTLE=mix 100000-1000 HASH_AT=400 966469f6/34801e1a; the record layout gives the same hash.
- Pitfall: _SIM_MOVE_WNAMES has several runs of '?-'; some are words a W_ constant still reads (73..78: W_HWIN..W_CBS,
  null on purpose). New words go only where no W_ constant points (storage-abi checks types, not this).
- Script versions bumped to ?v=20261025-st1 (every file had 20261024-ui5, through both earlier waves).
- Hits: hAcc + hTouch stay per slot; the status parts (hSty bits, hBurnD, hPoiD, hWatchK) are sub-records (unit.hSx + 1;
  hit.rsty / rbd / rpd / rwk) only hits with a status style take (k.rs hit_one: compare-exchange on hSx, -1 while taken).
  Sized by the status-style attacks counted where they are listed: the JS entries, and the movement kernel's list sites
  (mv.rs hit_sty_count, mv.hitsc per chunk; unit.atkSty bound at word 96, mv.hitsc at 97). The same count bounds the status
  records hits apply may take. 18 -> 9 B/slot.
  Tried first: whole hit records by place in hit.tlist (unit.hIx): no gain at 4M, where ~3.9M units are hit a tick (17 B a
  record + 4 B a slot), and reserving a status record per unit hit grew the pool to 2.7M records: the heap reached 4096 MB.
- Pitfall: every listing site of mv.hita must count (five: 3171, 3289, 3453, list_hit, 4311). One missed made the count
  short, and which unit lost its status then depended on the threads: 176 desyncs. The overflow warning goes to the peers'
  console, which tickbench does not show.
- 100000-1000 BATTLE=mix HASH_AT=400: 966469f6/34801e1a (the step-1 reference), 0 desyncs, mean 36.7 ms (one run).

| step | live MB | peak MB | heap MB | unit B/slot |
|---|---|---|---|---|
| cut 3, 4M (checkerboard) | 3033 | 3185 | 3965-4064 | 418 |
| cut 3, 3M (checkerboard --units=3000000) | 2357 | 2578 | 3133 | 418 |

## Growth with match length (2026-10-25): navigation rebuilds

The wasm heap grew with the length of a match whatever the units did: 100000-1000 BATTLE=mix, live 683 MB at tick 571,
757-858 MB at ticks 3071-5071 with fewer units (135k -> 78k), heap 890 -> 1127 MB. Found with SIM_HEAP_SITES=1 and an
EVALOUT of live bytes by allocation site (scratch sites.sh / out.js / sitediff: live = _simHeapSiteOf grouped by site):
every array of the background navigation rebuilds (_navJobStep: nodes, fields, graph, parts, atlas), 4 -> 9 builds alive.
They were simHeapArrayAuto arrays, given back only when the JS collector took their views; a build's views are a few
hundred bytes of JS heap for 20-40 MB of wasm heap, so the collector had no reason to run.

Fix: flownav.js _navArr records every build and atlas array as navigation's (_navOwned); _navSweep (after a publish,
an install, a dropped next build, a reset, and every NAV_SWEEP_TICKS) walks the builds in use (_nav, _navNext.nav, the
job's b / next / atl / shared; shared builds share arrays, hence reachability, not ownership by build) and queues the rest;
NAV_FREE_TICKS (40) later simHeapFreeAuto (sim_wasm.js: unregisters the collector's entry, then simHeapFree's queue: jobs
in flight, two ticks, no name binding it). The atlas header holds raw addresses (not names): it is rebound with its build
at the publish, and the grace covers jobs started before.
Same run after the fix: live 681 MB at tick 3071 and at tick 5071, heap 890 MB throughout; hash 966469f6/34801e1a,
0 desyncs. Still to look at: JS heap after a forced GC 805 -> 863 MB and array buffers 205 -> 247 MB over those
5000 ticks (both peers in one process).
