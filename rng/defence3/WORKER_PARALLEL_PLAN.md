# Worker AI on the helpers (decide in parallel, apply by intents)

Direction from the user (2026-11-02): no serial worker logic on the
simulation thread; every worker's event decided on the helpers, shared
effects as intents reduced and applied deterministically (independent of the
helper count and of timing), as the movement does. Slight changes to results
are fine: a reservation lost to a lower id noticed at the apply, research
overshooting, resources going negative, idle searches by tick staggers.

Today (wasm/src/wai.rs k_worker_ai, called from unit.js unitEventsRun through
worker.js waiRun): one serial pass over ~13.5k worker events a step on the
1M/250k chaos scene (~2.6 us each, cache misses), then waiOutEvents in
JavaScript (~1.2 s of 37 s: spawnerProductionChanged 0.43, _waiBuilt 0.19,
_unitWorkerEvent 0.17). ~10% of the step on the simulation thread, all serial.

## Shared state the pass reads or writes, and its parallel form

| state | today (serial) | parallel form |
|---|---|---|
| reservations `resv` (tile * nt + type: one worker of a type a target), `rcount`/`rsum` region counts, `wswl` change list | read and written as each event runs; a lower id of the same owner and type evicts the holder (set_target, set_target_unit: rewrites the other worker's target, state, route) | decisions read the table as at the pass's start; acquire/release as intents (slot, id); apply: per slot the lowest id among the holder kept and the acquirers wins (today's rule); losers and evicted holders get the eviction's state change in the apply; counts and the change list from the applied changes (sums, list in slot order) |
| structure energy and build state of a target (stval, the class columns: progress, stacks, levels, maxEnergy override and its per-class count, uc, brain word tokens) | builder b_work and the progress ops (p_complete, p_upgraded, p_refresh, p_begin, p_maxe_set) write as they go; healers add energy | exclusive per worker type by the reservation, but a builder and a healer can share a structure: energy adds as intents (tile, amount, kind); apply per structure (radix-sorted by tile, parallel by tile): sum the adds, then the build/upgrade/stack transitions once (the p_* logic moves to the apply); per-class counters as sums |
| spawner queues paid (healers: queue column paid += work, capped) | written as it goes; OUT_QUEUE_PAID per payment (spawnerProductionChanged in JS, 0.43 s) | intents (tile, work), summed and capped at the apply; one production update per paid spawner after the apply (not one per payment) |
| a healed unit's energy | written (min(max, e + dps)) | intent (slot, dps); apply sums, caps |
| research per owner `rs` (active task, done, points; advance when idle) | deposits only while still needed; the queue's next task made active by the first researcher that needs it | deposits as per-owner sums (may overshoot); the "still needed" check against the pass's start; the advance once per owner at the apply |
| payments `payt`/`payl`, energy log `es`, counters `cnt` | per owner rows appended in event order | per-thread per-owner sums (or delta lists merged in event order), reduced after |
| work versions `ver`, `vsum` | bumped as it goes; idle searches compare them (work_hash) | bumps as intents summed after; searches read the pass's start values (or tick staggers, as the user suggests) |
| path windows free list `mfree` | set_path pushes freed handles | per-thread freed lists merged in event order after |
| out events `out` (sounds, mine taken, salvage, built, astar log, arm, declined, clear route, research advance) | appended in event order | per-thread buffers tagged with the event's index, merged in that order |
| the worker's own columns and record | written | written directly (each worker has one event a pass) |
| mines' amounts | read (exclusive by reservation), decreased in JavaScript after (OUT_MINE) | unchanged (read only in the pass) |

Reads of other units (heal targets' energy and position, reservation holders'
dead/owner/type/target, the id table) read state no event of the pass writes
once the writes above are intents.

## Stages

1. Kernel restructure: Ctx with per-thread outputs (out events with indices,
   freed paths, owner sums, version bumps, counters, intents); the event loop
   chunked over the helpers (simParallelRun), the reductions and applies as
   parallel kernels (radix sorts by key, per-key runs); the JavaScript glue
   (waiRun, waiOutEvents) for the merged outputs. One switch keeps the serial
   pass for A/B until the parallel one is verified.
2. Reservations as intents (removes the evictions from the decide pass).
3. Structure, queue, unit-energy and research effects as intents with the
   per-structure apply (the p_* transitions move there).
4. The search tier's takes (mode 1, take_one) and the progress ops (mode 2)
   the same way; waiOutEvents' JavaScript (spawner production updates) once
   per spawner.
5. Measure (Edge, chaos scene), tests (worker behaviour tests, two-peer chaos
   determinism with and without helpers: CHAOS_HOST_HELPERS), log.
