# Movement as wide SIMD loops: plan (2026-11-14)

**Goal (user, 2026-11-14):** get rid of nearly all scalar work in the movement kernels. The end state is a
few simple loops over structure-of-arrays mover data, wide SIMD (as many lanes as the data's width allows),
very few branches, very few scattered reads; everything in parallel jobs. Large reworks are fine; behaviour must
stay approximately the same (crowd flow, arrival, fights), determinism across peers and helper counts is required.

This supersedes the resolve parts of `MOVE_OCCUPANCY_OPTIMIZATION_PLAN.md` (sections 3.2-3.3) and
`OCCUPACY_OPTIMIZATION.md`; it keeps their mover table (3.1), events (3.3) and determinism rules (3.4).

## 00. Open: coarser occupancy cells (4 a tile, 8 px), with footprints matched to sprites

The one measured k89 win of this round (k89 -16/-18%, step ~-5/-7%; OPTIMIZATION_PROGRESS.md 2026-11-17 night last+3
and 2026-11-18). Default kept at 8 for now. Do it together with footprints that match the drawn size (~8 / 16 / 24 px for
small / middle / large units): 16 px needs even-width footprints in the kernels (details in the progress log).

## 0e. Inflated count maps instead of footprint tests (gate, 2026-11-18): not passed

A byte a cell per mover size class (the bitmap's set bits in the class's footprint square there; C-space inflation as
in robotics costmaps) turns a footprint test into one byte read and a commit into u8x16 row adds. Exact on the real
state (identical moves), but 0.53x: 187-191 ns a mover vs 101 for the bitmap. The maps are 24x the bitmap's bytes and a
commit writes ~20-50 separate cache lines; the bitmap's compactness (a block's rows in L1) is worth more than fewer
instructions. Details: OPTIMIZATION_PROGRESS.md 2026-11-18.

## 0a. (C) measured before building (2026-11-17): no headroom left in the layout

(C) assumed k89 is bound by scattered slot-column reads that block-ordered rows would remove. Measured on checker-200k-r0
(Node, 8 helpers, tests/test-runs/simd-c-20261117/ and teams8-20261117/):
- *Layout does matter in principle:* slots restored in block order vs randomly permuted: k89 work floor 7.3 vs 12.5 ms
  a tick (occ-sched-probe, prof build). The growth is all in the per-unit column readers: traffic_yield +187%,
  move_job +267%, occ_gather +185%, traffic_swap +114%, checked_traffic_q +61%, epi_slot, resolve_slot,
  walker_short_at; the bitmap work (clear_or_mark, field) +13-15%.
- *But today's layout is already at the block-order ceiling:* the online relayout in stress mode with a 32x budget
  (884k units moved in 214 steps vs 24k: every slab re-sorted continuously) gives k89 9.86 ms at ticks 300-420 vs
  9.65 / 9.46 by default (two runs). A stricter drift threshold or more slab slack: no change either. Block slabs of
  64 already put ~16 same-block units on each column line, about what contiguous rows would.
- The rise of k89 over a run (6.3 -> 9.6 ms in 400 ticks, in the shuffled run too) is the battle's load, not decay.

So rows authoritative for the hot fields would remove little: what is left in k89 is per-unit compute (block layout,
share of k89: footprint tests and bitmap 26%, gather / order / job loop 16%, resolve 13%, yields 12%, swaps 9%,
epilogue and traffic samples ~10%). (C) is not started; (A) and (B) stay as measured (slower). A SIMD rework has to
cut that compute (fewer or cheaper per-unit decisions), not memory traffic.

## 0b. Per-unit compute in k89: where it goes, how to cut it (2026-11-17)

Data: checker-200k-r0, Node, prof build with 8 helpers (occ-sched-probe PROF, dk 1 30 ticks / dk 4 20 steps) and
dbgc counters without helpers (counters.cjs, 20 ticks after 60): tests/test-runs/simd-c-20261117/ (under-block.txt,
under-dk4.txt, counters-dk1.json / -dk4.json, dbgcmap.cjs maps counter ids to code; ids 40-63 are occ.rs diag words).
185k units with footprints: 142k parked, 42k flow walkers.

| per tick (dk 1) / per step (dk 4) | dk 1 | dk 4 |
|---|---|---|
| rows scanned by the gather | 185k | 197k |
| entries gathered and ordered (90) | 62k | 80k |
| ... of them only for a push at their tile (84) | 31k | 37k |
| resolves with a wanted move (93) | 39k | 54k |
| shoulder tries (94 / 95) | 12k / 25k | 21k / 45k |
| swap searches entered (66) / chunk scans (67 hop ok) / done (72) | 10k / 1.8k / 1.0k | 16k / 12k / 5.4k |
| yield calls (73) / second resolves (80) / moved (81) | 30k / 17k / 14k | 39k / 25k / 21k |
| field builds (53) | 34k | 74k |
| k89 helper CPU (prof build) | 64 ms | 82 ms |

k89 inclusive shares (dk 1 / dk 4): main resolves (resolve_slot) 56 / 61%, of which footprint tests (preview, field,
motion_f, commit_preview, clear_or_mark) ~27 / 32%, swaps 11 / 22%, shoulders 7 / 6%, steer_pressure 5 / 4%; yields
21 / 16%; gather + order + job loop 16 / 10%; epilogue 3 / 7%. A resolve costs ~0.9 us inclusive, a yield call ~0.46 us,
a swap search ~1.4 us (dk 4), a footprint test ~140 ns. The footprint tests are SIMD already (a dilated 16 x 16 field
per mover position, 4-lane sweep lookups): their cost is how often they run (~2 per mover) and the per-mover field.

Options, largest first (estimates of k89 CPU; each to be measured, kept or reverted):
1. **Swap partner from a per-job owner map** (cell -> slot over the block + halo, written by footprint commits)
   instead of scanning the 3 x 3 chunks' index entries with the class filter: the partner is the unit covering the
   cells ahead. Swaps are 22% at dk 4 (12k scans a step, 5.4k swaps); est. -12..-15% at dk 4, -6% at dk 1. Behaviour:
   the nearest blocker ahead instead of the best of three by score: crowd benches (counter, plug), traffic-pressure.
2. **Block-level dilated legality maps** (D1 / D3 / D5 per radius class, the plan's P2) updated at commits, instead
   of a 16 x 16 field built per mover position (34k / 74k builds): field + fill_row + part of preview, est. -4..-6%.
   Exact if the maps equal the per-mover fields (the same bits).
3. **Yield cadence at dk 1:** a pushed standing unit yields on alternate base ticks (by id) with twice the push step
   (capped as now): half the yield calls, the same displacement a second. est. -8..-10% at dk 1, nothing at dk 4
   (one yield a step already). Behaviour: rally-pulse, crowd-traffic at dk 1.
4. **The gather's push test by a job-local chunk bitmask** (one bit per chunk of the block + halo, made once per job
   from the push records) instead of push_at for each of the 185k rows: exact, est. -3..-4%.
5. **Pushed-only standing units out of the leader order:** half the gathered entries are there only to reach the
   yield pass; ordering them by id alone (fewer radix passes) and keeping them out of the main loop: exact if the
   yield order stays (key, id); est. -2..-3%.
6. Smaller: epilogue only for units that crossed a tile (dk 4: 7%); steer_pressure moved into the first stage's
   vector lanes (5%, moves cost rather than removing it).

Together ~-20..-25% of k89 at dk 4 (1 + 2 + 4 + 5) and ~-20% at dk 1 (1 + 3 + 4 + 5); k89 is ~40% of helper CPU, so
~8-10% of the step. Not covered here: the first stage (k8, 8.6% of helper CPU) and flow looks (11.5%).

## 0c. Toward k89 near 100% 4-wide (investigation, 2026-11-17)

Three things keep k89 scalar: (1) order: each commit is seen by the next mover (Gauss-Seidel); (2) divergence: free /
clipped / shoulder / swap / yield are different code; (3) gathers: other units' state by slot. Techniques from other fields:

- **Conflict-free lanes instead of claims (multi-colour Gauss-Seidel, as in Vivace / parallel PBD; Noita's
  checkerboard chunks at lane scale):** split a block into 4 (or 8) sub-regions with guard bands of the interaction
  reach (step + footprint + shoulder, <= ~8 cells at dk <= 4). Lane k walks sub-region k's movers in leader order; the
  4 lanes run in lock-step (SPMD), so each lane is still Gauss-Seidel and lanes never touch the same cells: no claims,
  no validation, no vacating rounds (what made design (A) cost +15-25%). Movers inside guard bands go in a second,
  colour-shifted pass. Behaviour: the leader order holds inside a sub-region, not across sub-regions.
- **SPMD on SIMD (ispc model):** the resolve written lane-per-mover with masks; a branch is skipped when no lane takes
  it. Divergence costs both sides, so:
- **Wavefront queues (Laine, Karras, Aila 2013, "Megakernels considered harmful"):** the resolve as stages over
  compacted queues, each one coherent path: intent + steer (all) -> primary footprint test + commit (all) -> shoulders
  (clipped only) -> swaps (< 25% progress) -> yields (pushed standing). Left-packing by a 16-entry shuffle table (4 lanes,
  made at match start). Changes the order between stages (a clipped mover's shoulders after the followers' primary
  commits): measured with the crowd benches.
- **Narrow, block-relative numbers:** positions as i16 relative to the block (128 cells x 32 Q8 + halo fits) = 8 lanes;
  steering in f32x4 (deterministic: no FMA, no relaxed SIMD). Today's scalar steering and scoring are f64.
- **Tables made at match start:** compaction shuffles; per (step octant, length in cells <= 3) the swept cell offsets
  and the shoulder rotations of quantized steps (no divisions, no f64 rotation per candidate); footprint row masks per
  radius (exist).
- **Gathers once per job:** one packet (SoA, job scratch, ~50 KB for 800 movers: L1 / L2) filled by the gather; every
  stage streams it; slot columns written back once (publish). Bitmap rows per lane: scalar u64 loads inserted into
  vectors (wasm has no gather), then shift / mask / test in lanes. ClearPath (Guy et al. 2009) packs neighbours the same
  way for 4-wide SSE velocity obstacles.
- **Not adopted:** PBD crowds (Weiss et al. 2017: Jacobi contact constraints, fully parallel) would replace exclusive
  footprints with soft contacts: a different model. Floor-field CA parallel update with friction (Kirchner, Nishinari,
  Schadschneider 2003) is the claims model (A) already measured. Noita (falling sand, 64 x 64 chunks, dirty rects,
  checkerboard threads) is scalar per pixel: its useful parts are the checkerboard (= the lanes above) and dirty
  rects (skip sleeping regions; k89 already gathers only marked rows).

**Prototype gate before integrating:** a test-only kernel over dumped block inputs (tickbench KDUMP) running the lane
scheme for intent + primary test + commit, against today's resolve on the same blocks: cost a mover and the moved /
clipped counts. Keep going only at >= 2x on that path. Then the queues (shoulders, swaps, yields), then integration behind
a flag with crowd-traffic (open / counter / plug / wall at dk 1 / 4 / 20), traffic-pressure, rally-pulse, determinism
with helpers, rendered Edge. Estimate if it holds: ~70-85% of k89 instructions in lanes, k89 -40..-50%, step -15..-20%.

**Gate result (2026-11-17): not passed.** Quadrant lanes are exact (lane-order scalar and four-lane runs end identical) but
run at 113 ns a mover vs 102 scalar (46.9k real movers): the path is small L1 loads one lane at a time (no wasm gather),
not arithmetic. See OPTIMIZATION_PROGRESS.md 2026-11-17 (night, last).

## 0d. Re-architecture: cell transitions as bit-planes (investigation, 2026-11-17)

**What costs now (measured):** per mover ~100 ns on the primary path alone and ~0.9 us with shoulders, swaps and
yields; the time is many small block-local loads and branches per mover (field corners, wall tiles, 3-5 bitmap rows a
new cell, partners' columns), made one mover at a time because each commit is read by the next. Lanes over movers do
not help (prototype: 1.0x): wasm has no gather. What loads as vectors is the bitmap itself: a block is 128 cells wide,
one v128 a row.

**Idea (lattice-gas automata, multispin coding: one bit a site, collisions as word-wide Boolean logic):** decide the
cell transitions of all movers of a block with whole-row bit operations, not mover by mover. Sub-cell motion stays as
today (a step inside its cell needs no test); only the crossing into a neighbouring cell is resolved (dk 1: ~33k a
tick of ~47k movers; dk 4: ~75k a step, up to 3 cells a mover: rounds of one cell).

Data per block and layer (job scratch, 128 x 128 cells + halo, rows of 2 x v128):
- O: occupancy (the bitmap, as today).
- C[s][d]: intent planes: bit at a mover's centre cell when it wants to cross into neighbour d (8 directions) this
  round, per footprint class s (1x1, 3x3, 5x5): 24 planes, sparse (row masks of non-empty rows).
- Y[s][d]: yield planes (standing units with a push, direction from the push record), lower priority.

One round (k = 0..K-1, K = cells a step at most):
1. Scatter: each mover sets one bit in C[s][d] (d = the neighbour its continuous step crosses into first).
2. Leading edge: for class s (half width h) and direction d, the cells newly entered are a column / row / L of
   2h + 1 (4h + 1 diagonal) cells; free_d = AND over those offsets of NOT shift(O); winners W = C[s][d] AND free_d.
   A v128 row shift by one bit is a few ops (i64x2 shifts + a byte shuffle for the carry).
3. Trains (followers into cells leaders leave this round): a mover whose leading edge is covered only by footprints of
   same-direction winners also wins: fixed iterations (3) of W |= C AND shift(W, footprint pitch) masked by the
   blockers; a column advances together, as the Gauss-Seidel order gives today.
4. Conflicts between directions: phases in a fixed order rotated by tick (no bias), O updated between phases (clear
   trailing edges, set leading edges of W: row ORs / ANDNs); two winners of one phase claiming the same cells are
   separated by a parity rule (a second plane pass).
5. Losers fall back like shoulders: a loser's bit moves to its next candidate direction (+-45, then +-90, hand side
   first) for the next phase: whole planes shifted between direction sets, no per-mover code.
6. Swaps of equal footprints are a relabel only (O does not change): detect a winner-to-be blocked by an idle
   friendly unit as C_d AND shift(I, d) (I: idle-friendly plane); exchange the two units' positions (scalar, pairs).
7. Yields: Y planes resolved after the movers' phases, same operations.
8. Readout: each mover reads its outcome bit (moved / direction) at its centre: one bit gather; sub-cell position
   clamped inside its cell when denied (today's close-up behaviour).
9. Traffic deposits and push records from the planes: per tile popcounts of intent-minus-winner bits (blocked
   movers) by direction, word-wide; no per-mover scattered adds.

**Cost estimate:** per block, per phase, per non-empty plane row ~30-60 vector ops (shifted ANDs of 2h + 1 rows,
train iterations, O update). ~47k movers over ~800 blocks -> ~20k non-empty (plane, row) pairs a round -> ~1-2 M ops
a tick, ~1-2 ms on one thread vs ~64 ms helper CPU for k89 today (Node, dk 1); per-mover work left: one bit set, one
bit read, the sub-cell clamp, swaps' relabels, the epilogue for tile crossings (3-7% of k89 today). Steering by
pressure moves into the first stage (f32x4 over slot runs).

**Behaviour mapping:** Gauss-Seidel leader order -> trains + direction phases (the pedestrian-CA parallel update with
conflicts, which the crowd literature treats as realistic); swept multi-cell paths -> rounds of one cell; shoulders ->
fallback planes; swaps -> relabel of equal footprints (unequal sizes: none, or a separate small scalar list);
pushes / yields -> yield planes; walls -> wall tiles folded into O (8 x 8 cells a wall tile). Deterministic: Boolean
logic, fixed phase order by tick, no dependence on rows' or slots' order.

**Risks:** unequal footprints in one train; diagonal corner cutting; direction quantization when a step crosses two
cells in one tick (rounds handle it); block halos (rows of 2 x v128, phases as today); behaviour in counter-flow and
plugs (the crowd benches decide).

**Considered, not chosen:** continuum crowds (Treuille et al. 2006: density / velocity fields, no exclusive
footprints, by its authors not suited to packed crowds); a Jacobi double buffer with sort-based claims (design (A),
measured +15-25%); soft contacts (PBD crowds: a different model).

**Gate:** a bit-plane resolve of one round on the state proto-eval.js dumps (46.9k movers): time a mover against the
102 ns scalar primary path, and moved / clipped counts against it (behaviour proxy). Continue at >= 5x.

**Gate result (2026-11-17): not passed, 0.31x** (326 ns a mover vs 102). Intent planes are sparse (~1-2 movers an active
plane row over 24 planes), so row operations do per-mover work three times over (follower iterations) plus row loads.
Bit-parallel lattices need dense uniform sites. See OPTIMIZATION_PROGRESS.md 2026-11-17 (night, last+1).

## 0. Implementation design (2026-11-15): one fused block job, rounds over packets

User direction (2026-11-15): not a local trim of k89; background -> SIMD SoA tables -> foreground parallel
vectorized loops, few branches, minimal scalar work, over the whole flow (background looks / traffic / pushes ->
move -> occupancy -> background), and the move and occupancy stages combined so their memory round trips go.

**Where it starts (checker-200k-r0, headed Edge, render + sim, 8 helpers, ~234k units, dk ~1.3):** step mean 50.6 ms,
p95 64, p99 72; kernels' wall 37 ms of it: occupancy k89 21.2 (178 ms helper CPU a step), first stage k8 4.4; the sim
thread's own JS ~2 ms. At ~50 ms a step the match falls behind real time and the pace goes to 2 base ticks a step.
Per step (counters, Node, 190k alive, dk 1): 81k rows gathered, 56k resolved against footprints, 37k pushed,
18k shoulder searches, 8.4k swap scans, 12k short-walker retries. k89 CPU by function: traffic_swap 25,
checked_traffic_q 24, occ_gather 16, move_job 16, traffic_yield 16, clear_or_mark 14, epi_slot 13, walker_short_at
12, motion_f 10, field 9.5, commit_preview 9, preview 8, resolve_slot 7, steer_pressure 6.5, pushes / samples 9.

**Target shape of a block job (one kernel per colour phase, k8 and k89 merged):**

1. *Intent* over the block's rows (slot order inside the block: relayout keeps them in near-contiguous runs, so the
   4-lane vector paths load runs directly; strays by lane): the first stage's logic, its wanted step written into
   the job's packet (scratch), not into the x / y columns; heading, steer target, speed, class taken along.
   Reads only tick-start state of other units (x0 / y0, snapshots): neighbouring blocks of earlier phases have
   moved already. Outputs once keyed by slot chunk (hit lists, order pickup leftovers, mover-table scan, post
   lists) are keyed by block job; their JS consumers walk jobs in index order.
2. *Packet* (SoA, job scratch, priority order = (projection on the block heading, id), radix): slot, ox / oy
   (footprint), ex / ey (wanted end, pressure-bent), radius / layer / owner / profile, class bits, heading, rte.
   Standing in-block units follow the movers (indices >= movers: never vacate).
3. *Owner map* O (u32 a cell) over the movers' box + halo: STATIC (bitmap taken: walls of other blocks' units,
   anything unknown), EMPTY, or the packet index of the in-block unit covering it. A mover i may enter a cell iff
   O <= i or EMPTY (its own cells, or a leader's): followers and standing units are never entered.
4. *Rounds* (sub-steps of at most one cell, as the old discrete sweep's points; rounds = longest mover's sub-steps
   + catch-up): propose (all candidates of 4 movers a vector: main, slides, +-45 / +-90 shoulders; legality = O row
   loads + the centre's wall tile; score as the old weights), claim (min of round tag | index over the target's
   cells), decide (one pass in index order: a winner owns all its target cells and every leader whose cells it
   enters won: leaders' outcomes never depend on followers, so one pass is exact; no cycles by construction),
   commit (all winners' old cells cleared, then new cells set: O, the bitmap rows and counts, records, rows).
5. *After the rounds*: swaps (short movers; partner found by O around the point ahead: standing friendly
   in-block, the old eligibility rules; walkers passing walkers), deposits and push records, yields (pushed
   standing units are movers with the push response as their intent), column publication (x, y, vx, vy, out,
   steady), epilogue (index, areas, charges) for the units with output.

**Result of (A), 2026-11-15 (OPTIMIZATION_PROGRESS.md, same date, night):** built (wasm/src/mv_rounds.rs, ?rounds=1),
behaviour within ~1% at dk 1 / 4 (better at dk 20), but k89 +15% at dk 1 and +25% at dk 4 against the sequential
resolver. Parallel claims cost more than they save (the leader-order pass is needed anyway; legality is a few bit
tests in L1), and sub-steps multiply per-mover passes at long steps. The remaining cost is the scattered per-unit
column traffic around the resolve, so (B) / (C) (the fused job over block-ordered rows) is the lever, not the
resolve order. Points 3-4 above are superseded by a leader-order sweep over a local bitmap.

**Result of (B), 2026-11-15:** built and reverted (tests/test-runs/wholesale-20261115/fused-job-not-kept.diff): behaviour
equal, step +5% at dk 1 and +8% at dk 4: a block's slots are fragmented (mean run 3.5 slots; other blocks' units
interleave), so the intent's four-lane paths lose their streaming. (C) comes first: the hot state block-contiguous.

**Order of work:** (A) the rounds resolver with the packet as its interface, filled from the first stage's
outputs; old resolve code (checked_traffic_q, preview / motion_f / field, shoulders, traffic_yield, walker retry,
second pass) deleted when it lands. (B) intent moved into the block job, writing packets: k8's dispatch, the
mid-step mover-table sync, the first-stage word and need bits go. (C) rows authoritative for the hot fields, the
intent's vector paths streaming rows. Gates per stage: crowd-traffic open / counter / plug / wall at dk 1 / 4 / 20
(baseline in tests/test-runs/wholesale-20261115/crowd-old.txt), traffic-pressure, occupancy audit, scene-orders,
deltatick tests, multiplayer determinism with helpers; then the Edge run.

## 1. Where the time is now (chaos-1m-250k, dk 4, 8 helpers; round 2 of the occupancy work)

- Step ~131 ms; movement kernels ~46 ms of its wall: occupancy second stage (k89) ~33 ms (~300 ms helper CPU),
  first stage (k8) ~13 ms (~125 ms helper CPU). Whole step ~1,465 ms helper CPU.
- **k89 is ~75% scalar per-unit code**, ~15% SIMD (field build, swept points), ~10% 64-bit bit operations.
  Biggest pieces (ms helper CPU a step): footprint tests and writes ~85, resolve arithmetic ~45, job bookkeeping
  (gather, radix order, loop) ~45, swaps ~25, epilogue ~24, yields and walker checks ~26, pushes / samples ~15.
- One thread: bare occupancy resolve ~90 ms of k89's ~210; crowd behaviour (shoulders, swaps, yields, pushes) the rest.
  109k of 193k movers a step are clipped; a clipped mover costs ~3-4x a free one (shoulders, swap scan, push,
  second-pass retry): branch-heavy, divergent, gather-heavy.
- **k8 is ~45% SIMD** (`step4`, `combat4`, `park4`, `idle4`, `mark_need`), the rest scalar state logic
  (`move_flow`, `move_pre`, `step_slot`, `move_combat`, `ctl`) and per-slot gathers. Vectorizing around the
  gathers alone gains nothing (measured: `step4` reading whole steer records: no change).

Why the current design cannot be vectorized as it is:
1. **Sequential dependence:** each mover's footprint test sees the commits of the movers before it in the job's
   order (Gauss-Seidel). Lanes would have to be movers that cannot affect each other.
2. **Divergence:** free / blocked / slides / shoulders / swap / push / retry are different code per mover.
3. **Gathers:** every mover reads ~15 slot-indexed columns, the chunk index for swaps, push records, steer
   records; wasm SIMD has no gather or scatter.

## 2. The design in one paragraph

Movement state lives in **block-ordered SoA rows** (the mover table, made authoritative for the hot fields), so
the step streams contiguous arrays. A block job runs **a fixed sequence of flat passes**: intent (k8's logic as
masks over classes), block-local grids (static occupancy with walls, dilated per footprint class; an owner map;
a claim map), then **K resolve rounds**, each a few flat passes: propose (every candidate move of every mover at
once), legality (one bit lookup per swept point), claims (max-priority per cell), validation, **vacating
propagation** (followers move into cells their leaders leave in the same round), commit. Swaps, pushes, yields and
the second-pass retry become ordinary candidates and movers in the same rounds. Deposits and push records are
reductions over the movers sorted by tile. The epilogue rebuilds the block's tile index from the sorted rows.
What stays scalar is administrative: building packets once a step where rows are not yet authoritative, the
radix sort's scatter, per-lane row writes into the bitmap, publication to slot columns.

## 3. Data

### 3.1 Mover rows (persistent, per block, SoA slabs of 64)

Extend `mvt.rs` rows from 8 words to the movement's hot state, in the narrowest types that hold it, so one v128
carries 4, 8 or 16 movers:

| field | type | lanes / v128 | notes |
|---|---|---|---|
| x, y | i32 Q8 (and i16 block-relative copies per job) | 4 (8) | the working position; block-relative i16 for the rounds |
| tx, ty | i32 | 4 | the steer's target point (look), chase target, push target |
| hx, hy | f32 | 4 | committed heading (cvx/cvy) |
| spd | f32 (from the stats row at the event that changes it) | 4 | speed incl. status factors, refreshed by events |
| slot, id | u32 | 4 | publication, priority tie-break |
| meta | u16: radius 2, layer 2, team 7, wall profile 3, hand 1, class 4 bits elsewhere | 8 | |
| cls, flags | u8 x2 | 16 | class (idle, parked, walk, hold, chase, yield), flying, worker, frozen... |
| rte | i32 | 4 | route end (crowd rule for swaps, arrival) |
| due | i32 | 4 | next step it needs the cold path (wheels) |
| pri | u16 (per job) | 8 | resolve priority: rank by (projection on the block heading, id) |

~56 bytes a row: ~33 MB at 600k movers (fits the 4 GiB budget; static, allocated at match start). Rows are the
truth for these fields; the slot columns are published from them (only where a consumer reads them that step).
Writers of the old columns (~30 places in mv.rs, JS movement writers) move to the rows or raise a row event
(`mvtM` / `mvtS` marks exist).

### 3.2 Block-local grids (per job, scratch in the thread's heap area)

Region: the block (128 x 128 cells) plus a halo H = max reach in a round + footprint + swap reach (16 cells at
dk <= 4: 160 x 160 cells). Rows of a grid are 160 bits = 3 u64 (or v128 + u64).

| grid | per cell | size | made by |
|---|---|---|---|
| `S` static occupancy | 1 bit | 3.2 KB | global bitmap copy (row loads) minus this job's movers' footprints (row ANDN), plus wall tiles of the profile (8 x 8 cells per wall tile) |
| `D1, D3, D5` legal-centre maps | 1 bit | 3.2 KB each | dilation of `S` by 1x1 / 3x3 / 5x5 (row shifts + ORs: SIMD over the whole region, no per-mover work) |
| `O` owner | u16 mover index (0 = none) | 51 KB | each mover's footprint rows (straight-line v128 row stores) |
| `C` claims | u16 (round << 12 | priority rank) | 51 KB | max of claimants, v128 row read-max-write per footprint row |

Walls are inside `S`: a wall tile is 8 x 8 taken cells for ground profiles, so the separate wall walks
(`seg_open`, open ring) disappear: a swept point is legal iff its bit in `D_r` is clear. Flying / other profiles
get their own `S` only when present in the block (a mask of profiles present).

### 3.3 Per-tile descriptors (per step, flat passes over tiles)

- Pressure: the bilinear coefficients of the frozen traffic field per tile corner, so a mover's sample is one
  4-float load + lerp (plan item from OCCUPACY_OPTIMIZATION.md).
- Push response: last step's push record decoded once per tile (friendly part direction, hostile shove, hop) into
  a 16-byte descriptor; standing movers read it with one load.

## 4. The block job: passes

Every pass is a flat loop over the block's rows (or its listed rows) in 4-, 8- or 16-lane vectors, masks instead
of branches; per-pass work is identical for every lane.

**P0 Load.** Block-relative i16 copies of x, y (8 lanes); `pri` by LSD radix on (projection on the block heading,
id) as today (histogram passes are vectorizable; the scatter stays scalar).

**P1 Intent (today's k8, as masks).** For all rows at once: class masks; walk: heading toward (tx, ty) at spd x dk,
stop at it; chase: target point from the target's row (one load: the target's row index in the row); hold / idle
/ parked: zero step; yield: the tile's push descriptor; pressure: lateral scalar from the tile coefficients
(steer_pressure's algebra, f32). Out: wanted displacement (dx, dy) in Q8 per row, budget. State transitions
(arrival, look's end, shot due, wake, repath) only set an event bit; events go to the cold-path lists (3.3 of the
earlier plan). k8's `step4` / `park4` / `idle4` / `combat4` become this pass; `move_flow`, `move_pre`,
`step_slot`, `move_combat`, `ctl` become event handlers run only for event rows.

**P2 Grids.** `S`, `D1/D3/D5` (whole-region SIMD row ops), `O` (per mover footprint rows).

**P3 Rounds r = 0..K-1** (K = 3 at dk <= 4; a round moves up to ceil(step / K), at most 3 cells):
1. *Propose:* for each row, candidates c = wanted, slide x, slide y, +-45, +-90 (the shoulder fan, hand side first
   by score weights), swap (into the cells of the owner in front, if that owner is swappable for this mover: a
   lookup in `O`, then the owner's row flags), yield step (standing rows with a push). Positions as Q8 integers,
   all candidates computed arithmetically in lanes.
2. *Legality:* each candidate's swept points (ceil(length / cell) <= 3 a round) as cell indices into `D_r`
   (r = the row's footprint class): one bit lookup per point (8 lanes: scalar loads into an L1-resident 3 KB grid;
   no other memory). Candidates into another mover's current cells are legal here (other movers are not in `S`);
   they are settled by claims and vacating.
3. *Choose:* score per candidate (progress along the step 0.7, distance 0.3, hand bonus: today's weights) with
   illegal ones at -inf; best per row by vector max/select. Rows whose best is staying put propose nothing.
4. *Claim:* each proposing row writes `max(C, round << 12 | rank)` over its target footprint rows (v128 row
   read-max-write, masked to the footprint's width).
5. *Validate:* a row wins iff `C` holds its own value on all its target footprint cells (row loads, compare,
   all-true). Losers stay this round.
6. *Vacating propagation:* a winner's target may overlap the *current* cells of another mover (a follower stepping
   into the leader's place). It holds only if that mover also wins and leaves those cells. Iterate (bounded, 3
   iterations, fixed): `Stay` = current footprints of non-winners (row ORs into a bitmap); a winner whose target
   overlaps `Stay` (row ANDs) loses. Columns move as a whole in one round; a blocked leader blocks exactly its
   followers. A chain longer than the iteration bound loses at its tail (deterministic; next round retries).
7. *Commit:* winners' old footprints cleared and new ones marked in the global bitmap (row RMWs, counts kept),
   in `S`-free form also in `O`; positions, budgets updated in the rows. A swap commits both rows (the partner to
   the mover's old position: legal by construction, its cells were the mover's).

**P4 Reductions.** Pressure deposits and push records: rows sorted by tile (they are, by P0), segmented sums per
tile in lanes, one write per tile. No per-mover scattered `saturating_add` into shared arrays.

**P5 Epilogue.** New tile per row (vector), rows that changed tile compacted (shuffle-table compaction, tables
built in the heap at match start), the block's tile index rebuilt from the rows (histogram + prefix + scatter),
area / charge bookkeeping as masked passes over the compacted list.

**P6 Publish.** x, y (and prev, vx, vy where read) to slot columns: one scattered store per field per moved row
(scalar by nature: no scatter instruction), straight-line.

Threads: block jobs in the four colour phases as today (a block's halo writes stay in its phase's territory).
All rounds of a block run inside its job: no extra barriers.

## 5. Behaviour and how it stays close

| today | new | effect / check |
|---|---|---|
| Gauss-Seidel order: leaders first, each sees earlier commits | rounds with priority = the same leader-first rank; vacating propagation lets followers enter cells leaders leave in the same round | columns still move as a whole; contention decided by the same rank. Check: rally-pulse, crowd-traffic (counter, plug), stuck-flow, chaos progress |
| sweep sampled at ceil(len / cell) points | same points, per round (a round's length <= 3 cells) | identical for free paths; blocked movers close up per round |
| shoulders only when < 80% of the step | all candidates every round, scored (illegal = -inf) | shoulder use decided by score as today; cheaper because uniform |
| swaps via a 3x3-chunk scan, hop cadence, crowd rule | swap candidate from `O` (the owner in front), same eligibility rules (standing friendly, not of the mover's crowd, worker rules) | far fewer reads; rule unchanged |
| walker retry in a second pass | later rounds | subsumed |
| pushes read next step, standing units yield | the same records; yield as a candidate in the rounds | unchanged timing (last step's pushes) |
| walls by segment walk | wall tiles in `S` | equivalent for tile walls at cell resolution |

Acceptance (as before): no overlap, wall or accounting failures; aggregate progress within 5%, fixed-time arrival
fraction within 5 points; traffic-pressure, rally-pulse dk 1 / 4, crowd-traffic counter / plug / wall,
stuck-flow 4M, occupancy audit (bitmap = footprints, counts = bitmap).

## 6. Determinism

- Priority from (projection, id): no dependence on row order, slot layout or helper count.
- Claims are max operations (commutative); vacating iterations and K are fixed; all per-row arithmetic exact f32 /
  integer ops (no FMA, no relaxed SIMD).
- Shared outputs: per-tile reductions in tile order inside the job; cross-job outputs only through disjoint
  phase territories (as today).
- Rows are audited against the slot columns (`k_mvt_audit`) in the determinism tests.

## 7. What stays scalar (and why)

- No gather / scatter / compress in wasm SIMD: packet loads of non-row data (chase target rows, tile
  descriptors), publication stores, radix scatter, the per-lane bitmap row RMWs. All straight-line, no decisions.
- Event handlers (state transitions) for event rows only: a few thousand rows a step, not 600k.
- Target: under 10% of the movement's CPU in scalar code (profile families: lanes vs. scalar functions).

## 8. Stages (each measured with ab.sh on chaos-1m-250k dk 4, one thread and 8 helpers; keep / revert)

| # | stage | done when | expected |
|---|---|---|---|
| 1 | Rows hold the hot fields (3.1); k89 reads only rows (P0 + packets) | k89 has no slot-column reads in its loops; audit clean | small alone; enables the rest |
| 2 | Grids `S`, `D_r`, `O` (P2) and legality by lookup; walls in `S` | `field8/16`, `motion_f`, `seg_open`, open ring out of k89 | footprint tests ~85 -> ~20 ms CPU |
| 3 | Rounds with claims and vacating (P3) replacing the sequential resolve, shoulders, swaps, yields, retry | `checked_traffic_q`, `preview`, `shoulders`, `traffic_swap`, `traffic_yield`, `walker_short_at`, the second pass out | k89 ~300 -> ~100-120 ms CPU (prototype first, below) |
| 4 | Reductions (P4) and tile descriptors (3.3) | `deposit`, `push_deposit`, `sample`, `push_response` per mover out | ~15 -> ~4 |
| 5 | Epilogue and index rebuild (P5) | `epi_slot` out; JS slot updates after movement out | ~24 -> ~8 |
| 6 | k8 as P1 + events | `move_flow`, `move_pre`, `step_slot`, `move_combat`, `ctl` run only for event rows | k8 ~125 -> ~50 |
| 7 | Narrow types and 8 / 16 lanes where the data allows (i16 positions in rounds, u8 classes) | | +20-30% on the passes |

Prototype gate before stage 3: a test-only kernel running P2 + P3 on a dumped block set (the dk 4 chaos scene's
blocks after the first stage) and on the crowd benches' scenes, compared with today's resolve for progress and
cost. If rounds + vacating lose more than 5% progress in the counter / plug cases, try K = 4 and longer vacating
chains before integrating.

**Expected end state:** movement kernels ~425 -> ~150-180 ms helper CPU a step (k89 + k8), i.e. ~15-20 ms off a
~131 ms step at dk 4, with the remaining movement code almost entirely flat SIMD passes. Estimates; the stage
measurements decide.

## 9. Risks and open points

- Behaviour of simultaneous rounds in head-on counterflow (the case the 2026-11-13 walk failed): needs the
  prototype gate; swaps and the hand rule are the levers.
- Long steps (dk 20 benches, 35 cells): K grows with step length, or rounds of up to 3 cells with a
  ceil(step / 3) round count for those rows only (rows done early drop out of the lanes: compaction per round).
- Halo: movers whose reach exceeds the halo (very long steps, teleports) go to an exceptional batch after the
  phases (exclusive, still the same passes).
- Rows authoritative: every movement-column writer must go through rows or events; the audit catches misses.
- Memory: rows +33 MB static; grids are per-thread scratch (~120 KB a thread).
