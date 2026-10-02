# Determinism audit report and implementation plan

## Summary

The code has substantial determinism safeguards, but the audit found **two reproduced execution failures**, alongside recovery, hashing, and cross-engine weaknesses.

The highest priorities are the background dispatcher’s lane-reuse race and the failing kernel/object-equivalence case. Passing individual scenarios does not establish general determinism.

This report is delivered in chat under Plan mode. No workspace files were changed.

## Findings and proposed fixes

### 1. P1 — Background lane reuse can execute a chunk twice

**Location:** [sim_parallel.js:1694](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/src/sim/sim_parallel.js:1694), particularly the helper claim loop around line 1777.

**Reproduced:** A helper pauses after claiming an out-of-range chunk from job A. The coordinator completes A and reuses the lane for job B. When the helper resumes, it checks B’s total and invokes B’s kernel using A’s claim.

In the controlled real-thread probe, B’s chunk 1 executed twice. The ticket’s job-ID bits are not validated. This can also contaminate completion accounting and permit publication before all legitimate chunks finish.

**Implementation:**

- Add an atomic generation and active-reader count per lane.
- Helpers enter the lane’s reader section, recheck that its generation remains open, then claim and execute against that generation’s descriptor.
- Collection closes the generation and drains readers before parameters, bindings, or descriptors can be reused.
- Keep the lane closed after collection until a new descriptor is fully published.
- Release reader counts in `finally`; count completion only for valid chunks of the owning generation.
- Do not rely solely on the existing wrapping seven-bit job ID.

### 2. P1 — Kernel and object updates produce different gameplay

**Location:** [unit.js:2685](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/src/things/unit.js:2685) and the movement/chase kernels.

**Reproduced:** Running `node tests/kernel-object-equivalence.test.cjs` fails for seed 13, `crossroads`, at sampled tick 267:

| Field | Kernel peer | Object peer |
|---|---:|---:|
| Unit 16 x | 595.375 | 591.375 |
| Unit 16 y | 385.125 | 384.375 |
| Path ready tick | 258 | 242 |

The trace shows the kernel peer consumes/replaces the chase path earlier. The precise underlying branch remains unproven. Disabling the separate movement-step kernel did not remove the failure.

**Implementation:** Use the object state machine as the initial correctness fallback for `CMD_ATTACKING` units. Both movement kernels must leave these units for `Unit.update`, without changing their positions, path indices, or movement charges. Preserve the pass-start position/death snapshot required by other units.

Retain optimized movement for ordinary move and attack-move commands. Re-enabling optimized attacking requires its own equivalence work; it is outside this initial fix.

**Risk:** Increased CPU cost in attacking populations. Measure that cost explicitly rather than accepting divergent behavior to retain performance.

### 3. P1 — Recovery discards gameplay damage accounting

**Location:** [unit.js:1847](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/src/things/unit.js:1847) and laser reporting/reset logic.

Status and laser damage accumulate in `stAcc` and `lzAcc`. Their later reports feed shrine income; laser reports also trigger retaliation.

**Reproduced:** A snapshot round-trip changed pending totals from `7/9` to `0/0`. Resync deliberately clears these totals on all peers. Peers can remain synchronized while recovery changes gameplay relative to uninterrupted simulation.

**Implementation:** Expose both totals as authoritative per-unit fields backed by their existing columns. Include them in snapshots and hashes, restore their values, and preserve them during history-cache flushes. Clear them only for new units or new matches. Continue resetting transient report flags and rebuilding beam references. Keep the four-tick reporting cadence.

### 4. P1 — Hashes omit future-affecting state

**Location:** [utils_snapshot.js:298](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/src/utils/utils_snapshot.js:298) and `_snapHashGlobals`.

**Reproduced:** Changing a flow-route destination or adding a queued order left the corresponding state hash unchanged.

**Implementation:**

- Hash route identity, destination, readiness, and crowd-arrival state.
- Hash queued orders in execution order, remaining unit IDs, and remaining order budget.
- Hash installed navigation wall state and pending rebuild start, step, and wall differences.
- Maintain navigation checksums when state changes; avoid scanning the map every tick.
- Preserve rolling hash scheduling and exclude peer-local slots and presentation state.

These are detection gaps, not proof that the omitted fields independently create divergence.

### 5. P1 — Packet checksums depend on locale ordering

**Location:** [main.js:4485](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/src/main.js:4485) and host bundle construction at line 4988.

Peer IDs are sorted with `localeCompare`. Different locale ordering can produce different checksums for identical packets and reject valid bundles. The host’s transmitted order still controls action execution.

**Implementation:** Introduce one shared code-unit comparator: `a < b ? -1 : a > b ? 1 : 0`. Use it for packet canonicalization and host ordering. Leave presentation-only collation unchanged.

### 6. P2 — Island spawn generation uses native trigonometry

**Location:** [map.js:670](Z:/data/gitrepos/aleksiklasila.github.io/rng/defence3/src/game/map.js:670).

**Reproduced:** On a 60×60 floor grid with six teams, the foreign-math harness changed a spawn from `(20,47)` to `(19,47)`.

Authoritative startup snapshots mitigate normal multiplayer impact, but seed-only generation remains vulnerable.

**Implementation:** Replace spawn trigonometry with checked-in direction tables for team counts 2–8, using exact cardinal and half-valued components. Retain existing rounding and walkability adjustment.

## Verification and acceptance

Existing checks passed for deterministic sorting, cross-engine math scenarios, snapshots, background navigation, real-thread separation/frame kernels, healer reductions, and 4,200-unit shared-spatial simulation. The seed-4242 equivalence case passed; the broader equivalence suite failed as described above.

Add targeted regressions:

- **Dispatcher:** Pause helpers around claims and descriptor reads; reuse lanes with different kernels, totals, parameters, and bindings. Require exactly one execution per valid chunk and no early completion. Cover every lane, repeated generations, and 0/1/7 helpers.
- **Movement:** Require the complete default equivalence suite to pass, including low-A* scenarios. Compare positions, paths, command transitions, resource spending, and sampled authoritative fields.
- **Recovery:** Restore before every damage-report phase. Compare shrine income, retaliation, and future state against uninterrupted simulation. Include partial patches, full snapshots, and slot compaction.
- **Hashes:** Mutate each newly covered field independently and require detection within its scheduled cycle.
- **Locale/maps:** Require invariant bundle checksums across collation behavior and invariant spawn coordinates under perturbed math.

The harness’s “exact” fingerprint selects fields rather than representing complete authoritative state. Add an independent canonical comparator covering authoritative entity fields, globals, queued work, and pending gameplay totals; use it alongside production hashes.

## Implementation order and compatibility

1. Repair the dispatcher protocol and add its controlled interleaving tests.
2. Add the attacking-state fallback and establish equivalence.
3. Preserve damage accounting through recovery.
4. Expand authoritative hashes.
5. Replace locale sorting and spawn trigonometry.
6. Run the targeted regressions and existing affected suites; measure attacking-fallback performance.

Add a determinism-version field to startup and sync messages. Reject incompatible versions before starting or restoring a match. Update snapshot format handling for the new authoritative fields.

Keep unrelated optimization work unchanged. Revise the historical desync report to distinguish verified defects from speculation: natural array order and floating-point arithmetic alone do not establish nondeterminism.
