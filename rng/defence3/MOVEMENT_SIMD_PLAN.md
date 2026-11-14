# Movement as wide SIMD loops: plan (2026-11-14)

**Goal (user, 2026-11-14):** get rid of nearly all scalar work in the movement kernels. The end state is a
few simple loops over structure-of-arrays mover data, wide SIMD (as many lanes as the data's width allows),
very few branches, very few scattered reads; everything in parallel jobs. Large reworks are fine; behaviour must
stay approximately the same (crowd flow, arrival, fights), determinism across peers and helper counts is required.

This supersedes the resolve parts of `MOVE_OCCUPANCY_OPTIMIZATION_PLAN.md` (sections 3.2-3.3) and
`OCCUPACY_OPTIMIZATION.md`; it keeps their mover table (3.1), events (3.3) and determinism rules (3.4).

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
