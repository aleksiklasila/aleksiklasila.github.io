# Collision, shared stats and memory — 2026-10-20

4,000,000 starting units, 125,000 opposing mixed towers, 1000×1000 map,
checkerboard groups of 32, Ryzen 7 4800H, Node 24.19 memory64, seven helpers.
Whole tick wall time includes GC, worker waits and the machine's paging.
No forced GC, prefaulting, process cleanup or memory-pressure exclusion.

## Retained implementation

- Vectorize stationary contact forces in four f32 lanes; preserve the
  scalar path for exceptional/moving contacts. Reuse floor/half-up rounding
  for the opposite contact. Contact queries have a default budget of 8
  (a SIMD batch can overshoot by 3); 0 selects unlimited queries.
- Page optional unit references; use interned byte/word handles for type
  names and shared stat objects. Empty order/role columns allocate no pages.
  Building, producer and floor stat references use the same interned handles.
- Remove unused separation mirrors and avoid manufacturing worker-target
  state when retiring an ordinary combat unit.
- Remove six Float32 unit columns, not just their reads: `mvSpd`, `mvCost`,
  `mvChs`, `cbRange`, `atkCd`, `atkDmg`. No backing arrays, bindings, grow/
  compaction copies, initialization, or stat-refresh writes remain for them.
  Movement, acquisition and hit resolution read a shared row instead.
- Each hot shared row is 16 Float32 values (64 bytes), addressed by the
  unit's row handle. Equal SIMD row IDs broadcast from one shared row;
  mixed groups gather. Acquisition shares a row-ID vector between range
  and damage, rather than streaming two separate per-instance stat vectors.
- Research and boost updates rewrite existing shared rows in place. Handles
  stay valid, so numeric consumers immediately see the update without a
  unit traversal. Existing staggered housekeeping still updates visibility,
  maximum-energy mirrors and navigation checks. That remaining bookkeeping
  has not yet been eliminated; this is not the final minimal entity layout.

`entity-storage.json` inventories every numeric unit field, JavaScript field,
reference column, and all 11 structure/floor/mine schemas. WASM unit storage
is now 517 bytes/slot versus 543 before this removal; JavaScript numeric
state adds 87 bytes/slot, plus objects, references and shared/global indexes.
The six removed arrays save 96,043,008 bytes (91.59 MiB) at capacity 4,001,792.

## Measurements

Raw JSON, JSONL timelines, CPU profiles, paging samples and historical source/
binary fixtures are retained alongside this report. `comparison.json` and
`comparison.md` summarize runs that have completed.

The first cache-read-only experiment did not establish a TPS improvement.
The full removal experiment initially measured 659.08 ms/tick versus
654.16 cached. The first monitored pair measured 617.16 cached versus
692.93 removed. Both results are retained; footprint savings alone do not
prove speedup. The subsequent broadcast change addresses the redundant
scalar row reads in stationary contact groups.

At contact budget 4, the subsequent 32-tick pair measured 676.51 cached
versus 637.39 removed (1.478 → 1.569 TPS). This is an additional workload
comparison; the production default remains 8. Two Rust builds overlapped
part of the cached budget-4 run, so a final pair is run without other tests
or builds. It must not be treated as a controlled stat-layout speedup by itself.

### What is and is not a traffic measurement

Allocation bytes and the presence/absence of backing arrays are measured.
Process RSS/heap and page-fault deltas are sampled. The paired PowerShell
runner also records Windows system paging reads/writes and pages in/out,
including competing processes; these are not DRAM bandwidth counters.

The acquisition input stream changes from 32 bytes of per-instance range/
damage per four units to 16 bytes of row IDs plus shared-table accesses.
This is a source-level access-size calculation, not measured memory-bus
traffic. Cache reuse, prefetching and other kernels determine actual traffic.

Windows exposes `CacheMisses`, `DcacheAccesses`, cycles and retired
instructions through WPR on this machine. Starting the supplied strict PMU
profile fails with `Access is denied`, `0x80070005`, both inside and outside
the sandbox. No hardware cache/DRAM traffic improvement is claimed.

An administrator can run `tests/checkerboard-memory-ab.ps1 -HardwareCounters`
to capture the paired ETL traces. The counter profile follows Microsoft's
[WPR PMU example](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/recording-pmu-events).
The `majorPageFault` field in Node's Windows resource output is the native
process **total** PageFaultCount, including soft faults; it is not a measured
hard-fault count ([libuv implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/util.c)).

## Validation

- Shared-row test guards both `units` and slot owners with throwing proxies
  while publishing research; existing rows update, their handles survive a
  subsequent refresh, and no per-unit speed cache exists.
- Paged and interned reference tests cover defaults (including signed zero),
  sparse page release, widening 8→16→32-bit handles, growth and compaction.
- Movement replay reconstructs the removed columns only for the historical
  oracle, then compares all current arrays byte-for-byte at dk 1/4/20.
- Contact replay bounds f32 geometry errors; counts, closing and flow outputs
  remain exact in those replays. Strict old geometry equality is intentionally
  not a requirement of this optimization.
- Regression results are in `validation-final.json`. The research-queue UI
  test's missing panel rows also fails using the preserved cached layout
  (`cached-research-queue.log`); it was not changed to hide that failure.

## Reproduction

```powershell
# Actual cache allocation vs shared rows, sequential runs, paging monitored:
./tests/checkerboard-memory-ab.ps1 -Ticks 32 -RunName '-final'
# Full layout inventory:
node tests/entity-storage-census.cjs
# Hardware counters, from an elevated Windows session:
./tests/checkerboard-memory-ab.ps1 -HardwareCounters
```

Final unit-stat result: after fixing unnecessary navigation invalidation, the reverse-order normal-budget pair measured **620.12 ms / 1.613 TPS shared-only versus 633.75 ms / 1.578 TPS cached**. Live WASM storage fell 3785 → 3686 MiB, including the 16-bit shared-row handle. The matched final populations differed by 45 units out of ~2.99M. The first failed approaches above remain recorded.
