# Perf fuzzer: progress and findings

Tool: `node tests/perf-fuzz.cjs` (usage, options, thresholds: [tests/perf-fuzz/README.md](tests/perf-fuzz/README.md)).
Started 2026-10-26 after "selecting a lot of units and setting rally points still lowers TPS": a fuzzer that plays
random UI and in-game actions in real Edge for as long as you like and says what lowers TPS/FPS and what makes memory grow.

## What exists

* `tests/perf-fuzz.cjs` (CLI, planner, loop, report command), `tests/perf-fuzz/` (`session.cjs` browser/match/trials/leak
  hunts/profiling, `actions.cjs` the actions and scenarios, `probe.js` the page-side recorder, `analyze.cjs` the judgement
  and the report, `profile.cjs`, `cdp.cjs` worker heaps/profiles, `os-sampler.ps1` browser tree memory/CPU/GPU,
  `init.js` live WebGL object counts, `start-background.ps1`), `tests/perf-fuzz-analysis.test.cjs` (no browser).
* Measured: FPS/frame times, TPS/tick waits, worker ms per tick, long tasks, input handler times, wasm heap (memory/live/peak/
  free), JS heaps of the page and each worker, browser/renderer/GPU-process private memory, GPU dedicated memory, handles,
  CPU cores busy, machine free/available memory, WebGL objects, DOM nodes, JS event listeners, ArrayBuffers, layout/style/script ms.
* Per trial: reference window, action window, tail window, recovery time; flagged trials are repeated with CPU profiles of the
  page and every worker, after a control profile of an idle stretch; long main-thread tasks are attributed one by one.
  Leak hunts repeat an action twice over with garbage collected in the page and all workers, and need growth in two rounds.
* Self-test: `--plant=queueAction:90 --only=orders` (a 90 ms busy-wait in the order path) was flagged at once (score 6-39), repeated
  with profiles and named (`applyRallyTargets`, `applyUnitCommandTargets` callers; the spin itself shows as `now`).

## Validation runs (2026-10-26, dev laptop, Edge 155, Firefox holding ~8 GB, ~50 % CPU from other programs)

| run | fixture | length | what it showed |
|---|---|---|---|
| 1, 4 | 10000-160 | 3 + 6 min | loop, windows, profile repeats, report work; first-use spikes of 230-350 ms in the first trials of a session |
| 2 | 10000-160 + planted 90 ms | 5 min | detection and attribution as above; a page crash during the heaviest repeat (recorded as an incident, session restarted) |
| 3 | 50000-200 (82k units) | 12 min, 37 trials | 21 flagged; the findings below |
| 5, 9 | 10000-160, 50000-200 | leak hunts | hunts work; a single round flagged panel node/listener "growth" that a second round did not show (now needs two rounds) |
| 6, 7 | 10000-160, `--mp=2` | 7 + 2 min | two windows, lobby, alternating driver, peers measured, tick hashes equal (86-199 compared, 0 differ); TPS 1-5 for both players (see below) |
| 8 | 100000-1000 (200k units) | 22 min, 73 trials | 36 flagged; renderer memory +27 MB/min; findings below |

## Findings so far (each one is for the game, not the tool; numbers are from the reports)

1. **`gl.getParameter` in `drawUnitClaims` blocks the page on the GPU (renderer3d.js ~7681).** With 80k+ units drawn the claim pass
   (on from 20000 units) reads ~10 GL states per frame; the profile of a 2D, min-zoom window had `getParameter (native)` at 3096 ms
   of 7891 ms of page main-thread time (39 %), all of it from `drawUnitClaims`, and it is the self time of the long tasks: in the
   313 ms task of `combo:select.boxShiftGrow+group.assignRecall` 94.6 ms of the 154 ms of JS, in a 251 ms task 109.7 ms. A synchronous
   GL query normally makes the page wait for the GPU process to get through the commands queued before it, so (a hypothesis the
   profile fits, not yet tested) it serialises page and GPU process every frame and turns any heavy frame into a long task. Not
   yet fixed. To check: keep the viewport/framebuffer/blend state in JS instead of querying it, and compare FPS and the
   `getParameter` self time; `Defence3Renderer3D.claimCellPx = 0` (pass off) is the upper bound of what it can give.
2. **A big selection plus rally/orders costs TPS for a moment.** `rally.all` (box over everything, then a right click) with 41k
   selected at 82k units: TPS 20 -> 13.0 and 13.6 in the action window (two runs), worker ms per tick 11.5 -> 32 (worst 115) and
   16 -> 35 (worst 91), back to 20 in the tail. At 200k units with 131k selected: the first run 19.1 TPS and worker 29 -> 44 ms
   (worst 98); the repeat 9.9 TPS during the action, worker 28 -> 62 ms (worst 122), 17.8 TPS in the tail.
   Orders given to a selection of 100k+ units (5 trials) left the next window's TPS 22 % lower on median, 50 % at worst:
   `move + hold + box 80 % + shift box 80 %` left 10 TPS and 71 ms per tick (20 -> 10, 30 -> 71 ms) and took 27 s and a
   "select all, stop" to recover. `order.rapid` -31 %, `order.chain` -22 %, `scn.bigSelectRally` -16 % at 200k.
3. **Selection spikes on the page at 200k units are 350-500 ms tasks**: `select.thrash` 450, `select.boxArmy` 362, `scn.groupsAndPan`
   453, `scn.marchToBattle` 427, `scn.bigSelectRally` 416, `combo:order.move+select.boxBase+queue.units` 441 (gap between tick results
   727 ms). `updateInfoPanel` (hud.js:6231) was +494 ms beyond the control in a thrash + rally trial at 60k units (975 ms self time),
   `getOrderMarkers`/`pushMarker` +90-170 ms, `assign_worker` `assignNearestXY` +445 ms for a shift-click chain.
4. **JS heap churn**: a select-all with orders moves the page's JS heap by +200 MB within seconds (276 -> 488 MB, 283 -> 496 MB, peak
   906 MB) and the browser's private memory by up to +470 MB in one trial; it comes back, so garbage, not a leak (`avoid GC` priority).
5. **Camera zoom doubles the worker's tick cost**: at max zoom worker ms per tick 9.5 -> 18.3 (82k units) in both runs of `cam.zoom`.
   Worker ms per tick also differs with zoom class (min zoom 15.8 ms vs mid 9.5 ms in the calm windows of run 3).
6. **Memory over 19 minutes at 200k units** (run 8, after warm-up): wasm heap flat (775 MB memory, 600 MB live, 21 MB free); browser
   private +26.8 MB/min (4093 -> 4565 MB, max 5363), renderer +27 MB/min; JS event listeners +416/min (3.7k -> 12k); GL textures
   +0.35/min and buffers +0.64/min. The page JS heap and handles have no trend. Whether the renderer growth is a leak or the game's
   own state (units fighting, effects) is for a longer run: `--hours=8` and look at `rising` and the idle checkpoints.
7. First-use spikes: the first time a session runs an action the page task is often 300-450 ms (17 of 36 flagged trials in run 8;
   e.g. `scn.groupsAndPan` 453 ms). Several reproduce on repeat, so not only first use.

## Caveats

* Two full simulations (`--mp=2`) on this one laptop ran at 1-5 TPS on the 20k-unit fixture, and the repo's own
  `tests/browser-mp-gui-fuzz.cjs` measured tick gaps of 400-750 ms at the same time (its checked-in results from the day before:
  70-160 ms). With no helper threads, or 3 per player, the same. Machine load or an MP regression: not decided. Multiplayer runs
  are good for relative effects and the desync/hash checks.
* Two stray `python3 -` processes (Oct 22 and one left by a hung command of this session) were burning a core each.
* Not tried: scenes of 1M-4M units (this machine had ~2-3 GB free), `--vis=team|history` rotation, `--wasm64`, real WebRTC multiplayer.

## Next

* Fix 1 (sync GL queries), then re-run `--only=selection,orders` at 200k to see the long tasks and `fps` flags go.
* An 8 hour run per visibility mode (`--vis=full,team,history`) for the memory trends; a 4M scene on a machine with RAM.
* A Chrome trace of frames that are long without a long task (GPU/compositor), as `tests/action-spike.cjs TRACE=1` does.
