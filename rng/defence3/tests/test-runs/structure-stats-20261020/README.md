# Shared structure/floor stats and contact-budget experiments, 2026-10-20

## Work retained

Stats for every unit/building owner/type/level live in flat Float32 tables. Both level-major (AoS) and stat-major (SoA) layouts are implemented for measurement; stat-major is the production default. Shared entry views preserve property access and serialization while research updates the numeric table in place. The complete shared numeric tables at the small-world census occupy 1,193,136 bytes (553 tables), alongside the existing shared hot unit rows.

Buildings/floors no longer allocate columns for preComputedBase, preComputedEffective, preComputed, preComputedPotential, currentStats, baseStats, maximum energy, floor damage or producer cooldown. Coordinates derive from tile coordinates as well. Rare genuinely unique overrides use sparse maps; all ordinary starting structures have zero such overrides. No per-instance stat-row pointer is needed for structures: owner/type/level select the row.

Deleted building research versions, catch-up and sweep machinery, its gameTick call, periodic structure/floor refresh buckets, selected-structure refresh work, adjacency stat-object rebuilds and four adjacency signature columns. Numeric research/boost publication does not trigger adjacency work. Maximum-level research still triggers upgrade eligibility; house population cap changes remain functional. Adjacency group/effective-level calculation, construction/upgrade progress, worker state and visibility coverage remain necessary mutable game state.

Census row storage (reference slots counted as eight bytes; shared handles at their actual width): towers 430 -> 360 bytes, barracks 415 -> 339, other producers 414 -> 338, research producers 424 -> 348, floors 348 -> 272, mines 64 -> 48. This is column storage, not an estimate of total JavaScript object/allocator overhead. See entity-storage.json and cached-entity-storage.json.

A rejected contact experiment (saved as experimental-lib.rs and experimental-wasm32.js / experimental-wasm64.js) uses a negative pair budget to count responses already received from earlier participants before searching for additional outgoing pairs. Positive budgets preserve the previous behavior; zero is unlimited. SIMD can exceed a response budget by up to three lanes, and later incoming responses can add more. This is not a strict contact-count limit or a constant-time neighborhood algorithm. The experiment is not enabled in production. Its first pair measured 548.65 vs 572.63 ms, but reverse order measured 545.24 vs 527.98 ms: no repeatable benefit. Production source and both binaries were restored to the existing outgoing-only budget. The unlimited replay still matches prior contact counts/flow and the accepted bounded f32 geometry error; the negative-budget replay checks determinism and fewer redundant contacts.

## Measurement

All runs start with 4,000,000 units, 125,000 mixed opposing towers, 1,000 x 1,000 map, opposing groups of 32, seven helpers, dk=1, three warm-up ticks and 24 measured ticks. Whole gameTick wall time includes GC, faults and scheduling stalls on the current machine. No memory cleanup, prefaulting or paging exclusion. Runs are serial; builds and regression tests do not overlap measured windows. Hashes are diagnostic; general regression tests and game behavior are the acceptance checks requested by the user.

See comparison.md / comparison.json, raw per-tick JSONL, JSON results and CPU profiles. Cached source fixtures preserve the pre-structure implementation while retaining the existing optimized unit layout. The direct-lookup trial reuses normalized type keys and directly selects the existing player stat row. Contact trials compare that same implementation with outgoing-only versus received-plus-outgoing budgets, in both run orders.

The first layout trio measured 586.44 ms cached, 597.87 ms level-major, and 564.16 ms stat-major. Tower time was 45.91, 57.24 and 34.26 ms respectively. The direct lookup run measured 572.63 ms. Reverse-order retained/shared versus cached repeats measured 527.98 vs 551.73 ms (1.894 vs 1.812 TPS), after the first comparable pair of 572.63 vs 586.44 ms (1.746 vs 1.705 TPS). Those two orders indicate approximately 2.4–4.5% higher TPS, with tower processing 18–25% lower. Scene survivors differ by only 3–4 units in the retained comparisons. This machine varies enough that individual kernel speedups should not be inferred from whole-tick timing.

Logical column allocation and process/OS memory are recorded separately. Process RSS and total heap need not fall in each noisy run despite fewer allocated columns. Windows Node majorPageFault reports total page faults (soft plus hard), not disk faults alone. Hardware cache/DRAM traffic was not measured: WPR PMU recording is denied by the current Windows user's non-administrator token, including outside the sandbox (see the prior collision report and preserved memory-traffic.wprp). No hardware bandwidth improvement is claimed from allocation or tick timing alone.

## Validation and reproduction

building-research-keys.test.cjs runs both layouts, blocks all instance collections and adjacency refresh during numeric research, checks immediate row publication, absence of cache columns, effective floor damage and unique overrides. The broader validation includes snapshot restore, worker roles, research rebase, state tables, combat targeting and action fuzz. The boost regression caught early Float32 intermediate rounding; linked range/cooldown values now calculate from the original local value before the final Float32 stores, matching complete rebuilds. Both layout tests check this consistency. A standalone scheduler test required its missing simDk=1 test-environment stub; its 120 oracle replays then passed.

Run benchmarks with the bundled Node 24 executable (memory64), for example:

```powershell
node tests/checkerboard-tps.bench.cjs --units=4000000 --map=1000 --ticks=24 --warmup=3 --stat-layout=soa --contact-budget=8 --profile --out=tests/test-runs/structure-stats-20261020/repeat.json
# Add --cached-structures for old structure columns; --stat-layout=aos for level-major.
# To reproduce the rejected contact variant, also pass --wasm64=tests/test-runs/structure-stats-20261020/experimental-wasm64.js --contact-budget=-8.
node tests/compare-structure-stats.cjs
```

The wasm build helper accepts --target-dir=... to avoid Windows mapped-file locks in an existing build directory. Both experimental WASM variants were built, then the original source-matched production binaries restored after rejecting the trial. Script versions bumped to tpsflat5.

Final validation: **22/22 main-thread regression files, 2/2 worker snapshot/deltatick files and 2/2 worker boost/research files pass (26/26 targeted checks)**. Contact replay and syntax checks also pass. Original failed runs remain in validation.json and validation-before-precision-fix.json; corrected final results are in validation-summary.json and its source files.

The retained repeat profile still attributes about 76 ms/tick of sampled main-thread CPU to sep_pairs and 124 ms/tick of elapsed phase time to background waits. V8 exposes the WASM function names here, not usable Rust source-line stall attribution. These profiles prioritize the contact/index pipeline, but cannot establish compute versus DRAM limits without hardware counters.
