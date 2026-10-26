# Perf fuzzer

Random player behaviour against a big match in real Microsoft Edge, for hours if you like, to find what makes
the **frame rate or the tick rate drop**, and what makes **memory** (wasm heap, JS heaps, GPU objects, the whole
browser) climb. Every action is real mouse and keyboard input through the browser (never a call into the game),
so the page's own handlers, panels, markers and renderer pay what they pay for a player.

```
node tests/perf-fuzz.cjs [fixture] [options]        run (Ctrl+C, or a file named STOP in the output folder, ends it cleanly)
node tests/perf-fuzz.cjs report <run folder>        rebuild report.md of a run (also written every 10 minutes while it runs)
```

Needs playwright (`PLAYWRIGHT_DIR=<a node_modules folder>` or `NODE_PATH`; on the dev machine
`Z:/data/Antigravity/resources/app/node_modules` is found by itself) and Edge. **Run it alone**: it measures.
A match of 80-100k units uses 2.5-4 GB of browser memory; with the machine short of memory (other programs, Firefox)
the page can die: that is recorded (`PAGE CRASH` in the incidents) and the session restarts.

## Quick starts

```
# a 3 minute look that everything works (small map)
node tests/perf-fuzz.cjs 10000-160.json --minutes=3

# overnight, the 100k a team fixture, sessions of 25 min with a fresh browser (memory resets), all three visibility modes in turn
node tests/perf-fuzz.cjs 100000-1000.json --hours=8 --vis=full,team,history > fuzz.log 2>&1

# the same, detached (no console window; a log and a STOP file in the run folder; prints how to stop it)
powershell -ExecutionPolicy Bypass -File tests/perf-fuzz/start-background.ps1 100000-1000.json --hours=8 --vis=full,team,history

# a multiplayer match: host and one guest in two windows, the players take turns, both are measured
node tests/perf-fuzz.cjs 50000-200.json --mp=2 --mp-delay=50 --minutes=30

# only selection and order trials; a scene as the start (solo only)
node tests/perf-fuzz.cjs scenes/mixed-200k.gz --only=selection,orders

# the same trials again (seeds and steps of an earlier run)
node tests/perf-fuzz.cjs 100000-1000.json --replay=tests/test-runs/perf-fuzz-<stamp>
```

Start it from a normal shell and leave the Edge window it opens visible (not minimised: a hidden page stops
drawing and the trial is skipped). `--headless` works, but then the GPU path is not the player's.

## What it measures

Continuously (every 2 s, `samples.jsonl`): FPS and frame times, TPS and the longest wait between tick results,
the simulation worker's ms per tick, the page's render-frame cost, long tasks and input-handler times, **wasm heap**
(memory / live / peak / free / arrays, from the simulation worker), JS heap of the page and of every worker
(sim, presentation, helpers), **browser process tree** (private bytes, working set, per type: renderer, GPU
process, utility; handles; CPU cores busy), **GPU memory** per process (Windows counters), the machine's free
memory and CPU load, live WebGL objects (textures, buffers, framebuffers, programs, vaos), DOM nodes, JS event
listeners, ArrayBuffers, layout/style/script ms per interval, units and selection size. Multiplayer adds the
other players' numbers, desync counters, fatal stops and tick-hash comparisons.

Per trial (`trials.jsonl`): the window before (the **reference**), the window of the action itself (`during`,
action plus 0.8-1.5 s of settling), the **tail** (the state it leaves behind: selection held, orders in flight,
a popup open...), the way back to a calm state (`recovery`: how long until TPS and FPS are back, and whether a
"stop everything" was needed), memory before and after, the page main thread's layout/style/script ms.

**Leak hunts** (about one trial in 16, `--leak-share`): one action that changes nothing for good (a view switch, zooming,
random UI clicks, selections, orders) is repeated 12 times to warm up, then 12 times again; the page and every worker
are made to collect garbage before and after the second round, and what is still held is compared: DOM nodes, JS event
listeners, ArrayBuffers, live WebGL objects, page and worker JS heap, wasm heap, browser and GPU process memory. A
count that grows by about one per repeat, or a size that grows by tens of MB, is a suspect; a suspect has to grow again
in a second measured round to be reported (`leak?` in the log, a table in the report).

## How a slowdown is decided

The reference is the median of the calm windows before recent trials (a trial with a prelude, e.g. a big
selection for an order, uses its own window taken after the prelude, so it is the order's cost that is judged, not
the selection's). A window gets a score from these components; a score of 1 is a flag:

| component | flagged at |
|---|---|
| `tps` | 15 % and 1 TPS under the reference (`--tps-drop`) |
| `fps` | 25 % and 8 FPS under (`--fps-drop`) |
| `gap` | longest wait between tick results over 200 ms and 3x the reference's p95 (`--gap-ms`) |
| `frame` | longest frame over 200 ms and 3x the reference's p99 (`--frame-ms`) |
| `long` / `handler` | a main-thread task over 150 ms (`--long-ms`) / an input handler over 100 ms (`--handler-ms`) |
| `sim` / `simMax` | worker ms per tick over 25 ms (half the tick budget) and 30 % up (`--sim-abs`, `--sim-rel`) / slowest tick over 60 ms (`--sim-max-ms`) |
| `persistent` | TPS/FPS not back after 20 s of waiting and then a "select all, stop" (`--recover-s`) |
| `wasm-grow`, `mem-grow` | wasm heap grew 128 MB / browser private memory 600 MB during one trial and was still there once the match had recovered (a big selection moves the page's JS heap by 200 MB and more: garbage, not a leak; the leak hunts decide) |

`@during` and `@tail` say which window. In multiplayer other players' flags are prefixed with their name.
`firstUse` marks the first time an action ran in a session: a spike there is one-time work that belongs in the
loading phase.

A flagged trial (score >= 1.5) is **repeated with CPU profilers** on the page and every worker, after a control
profile of an idle stretch of the same length. The report names what each thread spent *beyond the control*, so the
match's ordinary cost is not blamed. The `.cpuprofile` files (open in DevTools) are in `profiles/`. `confirmed on
repeat` means the repeat was flagged too.

## Output (`tests/test-runs/perf-fuzz-<stamp>/`, ignored by git)

| file | content |
|---|---|
| `report.md` | what each action does to TPS/FPS, by category, by context, what holding a state costs, settings against frame rate, worst trials with profile attribution, first-use spikes, idle checkpoints, memory/resource trends (slope per minute, `rising`), incidents, page errors |
| `trials.jsonl` / `samples.jsonl` | every trial / every 2 s sample |
| `checkpoints.jsonl` | idle checkpoints (no input for 8 s, standard view): the match's own trend |
| `incidents.jsonl`, `errors.jsonl`, `profiles.jsonl` | crashes, stalls, desyncs; distinct page errors with the action before them; profile summaries |
| `run.json`, `run.log` | settings, versions, GPU, commit; the console log |

## Actions

`select.*` (box over the army / everything / the base, shift-grow, thrash at 3-8 boxes a second, click, ctrl-click same
type, info panel "All/Idle", bottom bar menus, control groups), `order.*` (move, shift/ctrl chains, rapid clicks,
attack move, attack target, stop/hold, minimap, q/e resize), `rally.base` / `rally.all` (rally points of a selected
base, alone or with the army), `queue.units`, `build.place` / `build.dragLine`, `panel.salvage` (the info panel's salvage button on a selected group of buildings), `bar.boost`, `cam.*` (pan keys,
wheel zoom, zoom limits, minimap), `view.*` (2D, 2.5D, 3D, 3.5D, space, orbit, window resize), `ui.*` (settings popup with random
changes, random clicks through every control and menu, hover, mouse storm with a build ghost, random keys, info
panel, bottom bar, popups). Trials are single actions (60 %), random combinations of 2-4 (20 %) and scenarios
(20 %: big selection with orders and rally chains, thrash, groups while panning, view tours, UI tours, economy
storms, a march into the enemy, a big selection held while looking around). New actions get three times the
weight until they have run three times. Actions with nothing to act on (no army on screen...) are skipped, not
judged.

Add an action in `actions.cjs` (`add({ name, cat, weight, tailMs, prelude, run })`); `c.click/drag/key/wheel`,
`c.controls({ region, re, ids })` (the clickable things on screen), `c.geom` (own and enemy units and structures on
screen, the army's and base's world position) are the helpers.

## Options (`--name=value`, or the env var NAME)

`--minutes`, `--hours` (0: until stopped) - `--session-min` (25: browser and match restart; memory starts clean) -
`--seed` - `--vis=full,team,history` (one per session in turn) - `--mp=N` (players), `--mp-delay` (ms one way, 25),
`--mp-drive=alternate|host`, `--mp-helpers` (helper threads per player, default a share of the cores) - `--headless` - `--viewport=1600x900` - `--wasm64` (page URL `wasm64=1`), `--query` -
`--only=cat,cat`, `--skip=cat`, `--actions=name,name` - `--scenario-share`, `--combo-share` - `--profile=0`,
`--profile-score`, `--max-profiles` (12 a session, one per kind of finding) - `--leak-share` (0.06), `--leak-reps` (12), `--leak-nodes/-listeners/-js-mb/-wasm-mb/-priv-mb` - `--mem-limit-mb` (12000: the session ends and restarts), `--min-avail-mb` (300: ends the session when the machine has less than that available, free plus cache) -
`--base-s`, `--recover-s`, `--stall-s`, `--checkpoint-min`, `--report-every-min` - thresholds as in the table -
`--plant=fn:ms[:everyN]` (a self-test: busy-waits in a page function; the report must flag it) - `--out`, `--quiet`.

## Tests of the tool itself

`node tests/perf-fuzz-analysis.test.cjs` (no browser): the judgement thresholds, the probe's window summaries fed
frames and ticks by hand (a stall at the end of a window, missing frames), trends, CPU profile summaries, options.
The end-to-end self-test is `--plant=queueAction:90 --only=orders`: a 90 ms busy-wait in the order path must be
flagged, repeated with profiles, and named in the report. What the first runs found: `PERF_FUZZ_PROGRESS.md`.

## Known limits

* One page is driven at a time (multiplayer players take turns); the others are only watched.
* Multiplayer uses the BroadcastChannel PeerJS stand-in (no WebRTC, no worker-to-worker channel): lockstep and
  desync behaviour are real, network timing is a fixed delay. All players run on this one machine, so each is
  slower than on its own: on the loaded dev laptop a 20k-unit two-player match ran at 1-5 TPS (the repo's own
  `browser-mp-gui-fuzz.cjs` showed the same tick gaps at that time, 400-750 ms, against 70-160 ms in its results of the
  day before). Judge multiplayer runs by the relative numbers (what one player's action does to the others) and by the
  desync and tick-hash checks, not by the absolute rates.
* Memory and GPU counters are Windows only (PowerShell); elsewhere those columns are empty.
* A hidden or minimised window stops frames; those trials are skipped, the samples say `visible: false`.
* There is no AI player in the game: the other team's units and towers fight what comes into their range, so fights happen where the fuzzer sends the army.
