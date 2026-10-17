# Adaptive simulation implementation progress

Updated: 2026-10-17. Plan: `ADAPTIVE_SIMULATION_AT_HIGH_SIMULATION_COST.md`.

## Current scope and user decisions

Start with Stage A1 instrumentation and the real production startup path.
User overrides the plan's paused-world approach: **let gameplay run**, measure
startup, stabilization, TPS and FPS together. Do not benchmark smaller worlds
first. The first performance case is **2,000,000 total units, 200,000 total
buildings/floor items, 1000 × 1000, two teams**. Ordinary types are distributed
as evenly as possible. Each team has one king and one of each cloud portal
endpoint (four linked color pairs per team). Area upgrade actions and the
non-buildable passive shrine are excluded from placed-object totals.

Do not change when real matches begin yet. Use measured stabilization to inform
a later readiness policy. Tiny correctness tests are not performance baselines.

**No memory reserve, free-RAM cutoff, estimated-footprint admission check, or
paging cutoff.** The user explicitly rejected these. Let the requested world
load or fail; judge actual startup and in-game performance. Use memory readings
only to diagnose observed problems, then compact/optimize and rerun as needed.
The source plan's A1 and A5 now reflect this decision.

## Implemented so far

- `tests/load-world.bench.cjs`: serial real-Edge production Play Solo startup;
  exact seeded fixtures; initial counts/ownership/identity/placement/reference
  validation; initial snapshot digest; startup stage timing; live authoritative
  worker TPS, page TPS and rendered FPS; frame intervals; bounded stabilization
  observation; screenshots; actual surviving counts; return-to-menu check.
- Default stabilization: at least 10 seconds after initial readiness, then three
  consecutive two-second windows whose FPS and worker-TPS ranges are within
  15% of their means. Observation stops at 60 seconds, followed by a separate
  ten-second measurement. Low stable TPS is reported as such, not called 20 Hz.
- `tests/load-bench-page.js` is injected only by the benchmark server. Production
  `index.html` and gameplay timing are unchanged. The world is never paused.
- `tests/load-fixtures.cjs`: 36 primary count/map combinations, regression
  fixtures, and an all-types fixture derived from the current production roster.
- `tests/load-world.test.cjs`: exact totals and rare counts; stability/rate math;
  production startup and snapshot counts; duplicate-ID and impossible-placement
  detection. Passed on 2026-10-17.
- Browser stage events and partial reports survive a blocked page. System free
  memory is sampled for diagnostics only and never stops or skips a case.

## 2026-10-18: 2M in real Edge (the game's own Play Solo, ?loadmetrics=1)

Harness now: the plain game (`node tests/load-game-server.cjs 8128`, then
`?loadmetrics=1`, presets 2m/4m/8m in the overlay) driven by a scratch
playwright script (headed Edge; worker census over CDP: heap by binding name
and by allocation site). The old `load-world.bench.cjs` runner is gone.

Measured at 2M units / 200k statics / 1000², 7 helpers (one run each, the
machine ~40-50% busy with other programs; Edge private memory includes the
user's own Edge, ~4-7 GB):

| stage | time |
|---|---|
| model preparation | 27-31 s |
| page world creation (startGame) | 71-77 s: per team ~8.6 s spawn-tile BFS, ~13 s creating 1M units, buildings 1 s |
| adjacency | 2.0-2.3 s |
| page snapshot encoding (JSON) | 13.6-18.5 s |
| page restore of its own copy | 1.3-1.6 s |
| worker: parse 1.6-2.0 s, apply 43-56 s, nav 0.5-0.8 s, encode world 1.3-2.2 s | |
| worker ready / first world frame | 169-213 s after Play Solo |

The page is one blocked task for ~92-103 s (no overlay updates).

Blockers found, in order:

1. **Silence watchdog** (fixed): `SIM_CLIENT_SILENT_MS` 10 s in a match (and
   a size-derived limit while loading, at most 2 min) declared the worker lost
   during its first 2M ticks and threw the loaded world away (TPS 0 for good).
   Silence is no longer a loss (`sim_client.js`); the worker reports its own
   errors, and `restoreFailed` still triggers recovery at once.
   `tests/multiplayer-worker-lost.test.cjs` now loses the worker that way
   (it also exposed that the test terminated the respawned worker).
2. **4 GiB wasm heap overflow** in the first ticks: arrays allocated when the
   heap is full silently become plain shared arrays the Rust kernels cannot
   read, and every tick then failed (`SIM_KERNEL_NAV_FIELDS ... outside the
   wasm heap`). At tick 0: 2.95 GB live, of which unit columns twice
   (reservation 1.17 GB + compaction's second set 1.32 GB, the old one freed
   only 2 ticks later). Fixed: the restore reserves compaction's size (+1/8),
   and a forced compaction that would make the same layout keeps the columns.
   By tick 3 the flow-field pool asked for ~100k fields (all from
   `_findPathForUnitTagged -> navPathReach -> navNode`: one field per distinct
   destination tile; 32² Uint16 + 1920-byte row ~ 4 KB each) and its doubling
   took 1008 MB beside the old 500 MB. Pending: which orders ask for them, and
   a bounded field pool.
3. **Helper error flood** (fixed): a failing helper kernel logged a stack per
   chunk per tick (~50k lines in two minutes), freezing the page. Now three
   per kind, then counts at powers of two.
4. **System commit limit (Out of Memory)**: the Windows commit limit (RAM +
   page file) ran out while the worker loaded the 2M snapshot (free commit
   ~2.2 GB at the peak in earlier runs; our Edge ~13-16 GB private). The world
   exists several times during a start: page Unit objects (~1.4 GB JS heap),
   the JSON text (page, kept until the worker starts, and the worker's copy),
   the worker's parsed snapshot graph, the worker's Unit objects and the 4 GiB
   wasm heap. Paging cannot help past the commit limit. Next: A2 (the worker
   creates the world; no page world, no JSON round trip).

Unit storage is 614 bytes a slot (185 columns: core 51, status 44, levels 24,
movement/brain caches 490). The user asked (2026-10-18) to shrink the unit and
building/floor-item layouts now as well: narrow types, pack fields into shared
bit words wherever cheap (not only rare fields), sidecars where a group
applies to a subset. Column audit (types, Rust adapters and uses, kernels,
JS files): scratchpad `colaudit.cjs`.

## Runs and findings (before 2026-10-18)

- No smaller browser performance run completed. The earlier smoke invocation
  was interrupted before launch.
- Early attempts were stopped by an estimated-memory preflight and then a
  2 GiB free-memory reserve during model preparation. Neither is load-capacity
  evidence. These checks have been removed at the user's explicit direction.
  A proposed 1 GiB-reserve retry was interrupted before launch.
- Initial snapshot normalization changes some canonical hash buckets. The
  correctness test checks counts and references across restore and digest
  stability after normalization; it does not claim raw construction and first
  normalized snapshot are identical. Repeated seeded starts are compared.
- Browser attempt and final findings: pending; see the JSON report below.

## Resume commands

```powershell
node tests/load-world.test.cjs
node tests/load-game-server.cjs 8128
# then, with NODE_PATH at a playwright install (Z:/data/Antigravity/resources/app/node_modules):
CENSUS=10000 node .claude/load_probe.cjs 2m 12
node .claude/colaudit.cjs   # unit columns: types, Rust adapters/uses, kernels, JS users
```
(`tests/load-world.bench.cjs` no longer exists; the old JSON report
`tests/load-world-2m-200k-1000.json` is from it.)

Reports include machine/browser/helper information, available RAM, source SHA256
and Git revision when accessible. Browser processes run serially. Default helper
count is seven. Browser launching may require the environment's approval.

## Remaining work / qualification limits

A1 is **in progress**, not qualified. A2–A7 and B–E are not implemented here.
Process/GPU peak memory, precise population/placement/link subphases, multiplayer
transfer/readiness, selection interaction, loading cancellation, warm-repeat leak
plateaus and three-player asymmetry are pending. Stage wrapper times overlap;
do not add them. Initial validation is extra instrumented startup work and has
its own duration. FPS counts completed page render calls, not physical display
scanout. WASM/shared-array statistics are not a deduplicated allocation ledger.

Next: inspect the requested 2M case's last completed phase and failure evidence;
fix the first measured blocker, rerun exactly that fixture, and update this file.
