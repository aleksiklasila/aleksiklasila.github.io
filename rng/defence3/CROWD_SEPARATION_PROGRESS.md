# Crowd separation: progress log

Working log for CROWD_SEPARATION_IMPROVEMENTS.md. Read this first when resuming.

## Problem as measured (baseline 61758fa)

`node tests/crowd-scenarios.cjs all 1,4,20` (20 / 5 / 1 TPS, same game time):

- **Restless at rest.** An idle dense crowd with no orders churned at 5 TPS
  (5.3 px/s a unit) and 1 TPS (7.8 px/s), and its footprint grew 96 -> 189 px:
  the pressure velocity was multiplied by the step size (a 3 px overlap became
  a ~10 px push at 1 TPS) and the half carried to the next step was a second
  stale.
- **Jams moving the same way.** A 300-unit blob ordered across open ground
  moved at 12-16% of nominal speed (single units: 100%). `push4` cancelled up to
  all of every unit's navigation step in proportion to contact depth, whatever
  the neighbour was doing.
- A 900-unit block at rest -> one rally point: half arrived after 98-191 s
  (ideal ~80 s), 90% never; after arrival it kept moving at 3-9 px/s.

## Design now (all in the existing passes; no new pass over units)

Pair kernel (`wasm/src/lib.rs` `pair_exact`, same traversal as before):
- Each entry carries the unit's **committed movement** a base tick
  (`unit.sepIv`, packed i16 pair, written by `mv.rs push4` and the JS fallback
  `_unitPassUpdate`): its navigation step less the brakes; not the
  separation's corrections nor the closing response (fed back they swayed
  crowds: separation-jitter failed).
- **Closing response** (`sep.cx/cy`): only the closing motion along the
  contact normal is resisted, weighted in over the separation radius's skin.
  Shared travel, sliding and moving apart are untouched. A resting friend
  yields `UNIT_SEPARATION_SHARE_YIELD` (0.75) of it to a mover, scaled down by
  the contact's depth (no room past 0.45 of the contact distance) and by its
  own contact count (`sepMov` bits 2-4; 0.4 left at six or more); otherwise
  even shares. Used this update and carried into the next in `unit.sepCv`
  (a sample covers two updates under the stagger).
- **Local flow** (`sep.fx/fy`): friendly contacts' committed movement summed.

Movement kernel epilogue (`mv.rs push4`):
- **Geometric separation** relaxes the summed overlap by
  `1 - exp(-2 dk / UNIT_SEPARATION_RELAX_TICKS)` (P[59], `detExp`): never more
  than the overlap at any step size. At dk 1 half now, half carried; at dk > 1
  all now (nothing stale carried).
- **Sleep with hysteresis** for resting units in a resting crowd: no
  geometric correction while the deepest contact is under REST_SLEEP (0.4) of
  the radius; wake past REST_WAKE (0.6) (`sepMov` bit 1).
- **Coherent flow**: moving with the local flow keeps only FLOW_SIDE (0.5) of
  sideways separation.
- **Obstruction brake** (measured, not intent): deep in contact
  (SEP_BRAKE0 0.6 .. SEP_BRAKE1 1.2 of the radius) and not carried by the
  local flow (flow along its own step, at least SEP_FLOW_SHARE 0.3 of it), the
  whole navigation step is braked so; never exempt within SEP_GOAL_TILES (8)
  of its group's destination (travel converges there). Carried one update
  through the stagger (`sepMov` bits 5-7). Of the rest, the part into the
  overlap push is braked.
- Whole contact displacement bounded by CONTACT_SPEEDS (1.5) x its speed.

Arrival (`mv.rs move_flow`, `unit.js _followNavNode`):
- The crowd flag (`k_combat_scan`) counts only units of the **same
  destination** (route ends within 3 tiles: `unit.rtEnd`), 1 waiting, 2 idle.
- Within 8 tiles of the goal, a unit at a full crowd's edge (destination
  crowd adjacent, 18+ units in its 3x3 tiles) arrives without waiting for a
  stall; further out a stalled unit arrives at a full crowd with an idle
  neighbour (a crowd wider than 8 tiles).
- Group orders set `mvNavLD` at once (`main.js _ordNavLD`) so the first look
  can arrive; a group's unit already on the destination tile has arrived
  (was: walked to the tile's middle through the JS fallback, crushing the core).

Memory: two Int32 unit columns (`sepIv`, `sepCv`: 8 B a slot), sums block 4 ->
8 words a slot, one Int32 entry array (`sep.qv`). Kernel words 448-453 (mv.rs
W_SIV...; 300-427 are mv_move's step scratch: an early version put them at
300 and every intent read as zero).

## Results

`node tests/crowd-scenarios.cjs all 1,4,20` (seed 17), values at 20 / 5 / 1 TPS.
Baseline = 61758fa; now = this session's end (`.claude/crowd-baseline.jsonl`,
`.claude/crowd-v11.jsonl`).

| scenario, metric | baseline | now |
|---|---|---|
| idle dense crowd, travel px/s a unit | 0.16 / 5.3 / 7.8 | 0 / 0 / 0 |
| idle dense crowd, footprint px (start 91) | 97 / 124 / 189 | 91 / 91 / 91 |
| rally then rest, travel px/s | 1.36 / 9.4 / 8.6 | 0 / 0.25 / 0.12 |
| march 300 units, rear cohort speed (of nominal) | 0.12 / 0.02 / -0.22 | 1.08 / 0.95 / 0.69 |
| march, mid cohort speed | 0.16 / 0.13 / 0.29 | 0.98 / 0.95 / 1.04 |
| 64 through 200 resting, still stuck after 40 s | 64 / 55 / 29 | 7 / 9 / 28 |
| re-rally 4x/s, crowd radius px | 65 / 68 / 97 | 51 / 51 / 48 |
| re-rally, penetration (overlap share) | 0.04 / 0.24 / 0.33 | 0.22 / 0.21 / 0.30 |
| block 30x30 -> rally, half arrived s (ideal ~80 for all) | 191 / 148 / 98 | 52 / 79 / 56 |
| block, travel px/s at rest after arrival | 3.4 / 9.1 / 8.1 | 0 / 0 / 0.01 |
| block, mean radius after arrival (packed ~221) | 245 / 298 / 347 | 175 / 248 / 228 |
| block, still not idle after arrival + 20 s | 567 / 415 / 181 | 0 / 0 / 0 |

(Block: baseline 90% never arrived within 240 s at any TPS. "March" end
positions now stop in a queue behind the arrived front: p50 8-11 tiles from the
goal, packed radius 6.)

Existing tests: separation-integration, -entry, -jitter, -presentation,
unit-collision-smoothness pass; separation-rally fails at 20 TPS only
(penetration 0.21 > 0.2; maxDeepTicks: one wedged pair). Determinism:
multiplayer-chaos-determinism, deltatick-multiplayer, multiplayer-cross-engine,
shared-spatial-determinism, multiplayer-desync-recovery pass.
deltatick-fairness fails at baseline (fast units 1.45x ground at dk 10) and now
(that passes; fight damage a base tick 0.58x at dk 10: the armies now actually
meet, damage 988 vs 271 at dk 1; the small fight is noisy, friends-only closing
moved the dip to dk 4).

## Open

- Repeated rally torture test (same order 4x a second, `separation-rally`):
  20 TPS penetration ~0.21 vs the test's 0.2 (baseline 0.05) and one wedged
  pair in the compressed core; 1 TPS much better than baseline.
- Destination crowds build up on the approach side (centroid ~1 packed
  radius before the goal); spreading around the goal is not done.
- Low TPS overshoot: a unit moving 50-100 px a step can pass a gap before
  any contact is sampled (no swept contacts).
- Hold-position units are treated as resting (they yield).
- Navigation lane changes (lateral contraction toward tile-centre lines) not
  started.
