# 4M memory and area-search pass — 2026-10-21

Both acquisition modes remain available. Following the default switch,
area search and occupancy are enabled without URL flags. Comparison URLs
are `?acq=exact` and `?occupancy=0`. The benchmark also defaults to area
search, occupancy and its packed placement fixture; use `--exact-targets`,
`--no-occupancy`, or `--no-packed` for comparisons. `--dense-js-cache`
restores the saved original unit/cache sources. Historical results below
retain the explicit modes recorded in their JSON. No changes were committed
or staged by this pass.

The default switch also exposed an occupancy restore bug: restored/compacted
unit slots did not have their occupancy records rebuilt. Snapshot decoding
now rebuilds the grid after final slot assignment, stats and spatial epoch.
The default occupancy+area 4,200-unit zero-vs-seven-helper replay passes,
including its mid-run restore and restored footprint checks. This is separate
from the unresolved 4M no-restore repeatability issue documented below.

## Changes

- Fourteen JS-only path/failure cache columns now use implicit defaults and
  allocate 1024-slot Int32 pages on demand. Empty pages are released. Growth,
  compaction, detach and slot reuse preserve values. At 4M all fourteen were
  empty: approximately **214 MiB saved**, including page metadata.
- Sampled/area acquisition builds its CSR directly from the immutable slot
  snapshot, preserving entry order. It no longer allocates or writes the
  intermediate `acq.ex/ey/eo/ea/eid` columns: approximately **79 MiB saved**.
  The exact acquisition path retains its packed columns.
- The tile index no longer allocates/writes unused `ix.areas` per-unit keys.
  The disabled area sort was their only consumer. This removes approximately
  **16 MiB** and a population-wide write pass per full index rebuild.
- Worker searches now use area eligibility in area mode: resource collection,
  salvage, construction/repair, healer queues and units, research, both Rust
  tier and JS fallback paths. Bucket bounds enclose the eligible areas rather
  than a pixel-radius square. Distances rank candidates, without rejecting
  candidates from an eligible area. Existing tower searches already used
  area eligibility. Unit fallback/attack checks follow area eligibility too;
  fractional unit attack ranges round up in area mode.
- The fixed layout has one shared bounding box per area, about **1.93 MiB**
  on this map. Consecutive worker requests sharing source areas and range
  reuse the scratch membership result instead of repeating BFS. This cache
  uses a few stack words, with no all-pairs allocation. Dynamic enemy-area
  answer tables are still rebuilt by the acquisition tier; this pass does
  not claim to eliminate every BFS from the simulation.

## 4M results

Node 24.19, Ryzen 7 4800H, map 1024, 4M starting units, 125k starting
towers, seven real helpers, packed occupancy, six warmup and 24 measured
ticks. Runs/compiler jobs were serial. RSS and array-buffer figures below
are maxima sampled **during measured ticks**, excluding setup and the final
memory inventory/hash. Paging figures use the same measurement window.

| Case | TPS | Mean ms | P50 ms | Peak RSS MiB | Array buffers MiB | Live WASM MiB | Min available MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| Dense exact control | 2.971 | 336.624 | 251.056 | 4553.5 | 501.8 | 3460 | 875 |
| Sparse caches, exact | 3.037 | 329.308 | 262.008 | 4339.8 | 288.2 | 3460 | 1053 |
| Final exact | 3.137 | 318.756 | 231.966 | 4307.4 | 288.2 | 3446 | 1137 |
| Earlier area control | 3.698 | 270.383 | 229.736 | 4955.3 | 504.3 | 3595 | 689 |
| Direct packing + sparse caches, area | 3.666 | 272.748 | 239.830 | 4654.9 | 290.6 | 3517 | 925 |
| Final area | 3.989 | 250.703 | 216.119 | 4640.2 | 290.7 | 3503 | 960 |

Final exact saves **246 MiB peak RSS** against the dense control. Its
observed TPS improves **5.6%**. The older low-paging exact run reached 3.348
TPS, so this is a provisional comparison, not a stable measured speedup.
Dense/sparse cache controls used the same WASM binary. Final exact/area
use the same new binary, `344a1239c6ad64f9` (32-bit: `195aeea1603b771b`).

Final area saves **315 MiB peak RSS** against the earlier area run. The
final area behavior changed, including fractional attack range rounding;
its 3.989 TPS cannot be attributed solely to memory/copy optimizations.
The direct-packing-only area comparison was essentially tied on TPS.
Final exact ends with 3,878,343 units; final area with 3,451,007. These are
different workloads, so comparing their TPS is not an equal-work speed test.
Average page reads/s were 2.17 for final exact and 34.6 for final area.

**Unresolved:** 4M exact repeats still produce different unit-state hashes
despite matching survivor/tower counts; this predates this memory pass.
Final exact hash is `b0634562`, area `5a04d740`. All occupancy audits pass.
The small helper-count/snapshot determinism tests pass, but do not resolve
the large-run repeatability issue.

Raw large-run JSON, timelines and paging logs are in the sibling
`area-sample-20261021` folder, under `memory-*`. `summary.json` contains
the derived figures; regenerate with `node .../summarize.cjs`.

## Validation

- Sparse integer defaults/coercion/page release/growth/compaction; shared
  unit lifecycle, nondefault cache detach/reuse, reference columns,
  retirement, storage ABI and kernel ABI pass.
- Area worker kernel checks pass on WASM32 and WASM64: eligible targets
  outside pixel radius are found for builders, healers and collectors;
  disconnected areas and changed ranges are rejected correctly.
- JS area iterator/healer fallback/tower range regression passes, with
  legacy pixel-limited mode retained.
- Direct packing matches all CSR columns byte-for-byte against the old
  packing route. All four acquisition fixtures have **100% coverage**;
  independent area/structure oracles and outside-circle regressions pass.
  WASM32/64 target checksums match.
- Exact acquisition replay matches the saved exact build and brute-force
  oracle. The 40k exact replay retains hash `289883d5` from the dense layout.
- Spatial index builds/order, area boxes, solo/multiplayer snapshots,
  worker startup forwarding and 4,200-unit zero-vs-seven-helper determinism
  (including a mid-run restore) pass.
- `mixed-rally-move` reaches its PASS assertions, then Node 24 aborts at
  `process.exit` with `UV_HANDLE_CLOSING` on two attempts. Its process-level
  check is not counted as passing. This teardown issue was not changed.
- `git diff --check` passes.

## Reproduce

```powershell
pwsh -File tests/run-area-memory.ps1 -Mode Exact -Name memory-dense-control -DenseJsCache
pwsh -File tests/run-area-memory.ps1 -Mode Compare -Name memory-new -MemoryInventory
node tests/area-worker-search.test.cjs
node tests/area-worker-search.test.cjs --wasm64
node tests/area-search-range.test.cjs
node tests/area-acquisition-sample.bench.cjs --area-targets --direct-area-pack
```

Use a Node runtime supporting memory64 for the 4M cases. The script records
Windows paging counters and starts benchmark windows hidden.
