# All retained benchmark runs

Runs have different tick counts/contact budgets; compare matched workloads. All actual paging and stalls remain included. `static cache` means the six removed Float32 arrays, not all unit memory.

| Run | Ticks | Contact budget | ms/tick | TPS | Live WASM MiB | Mean JS heap MiB | Static cache MiB |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 12 | — | 699.80 | 1.43 | 3785.00 | 1837.87 | 91.59 |
| rounding | 12 | — | 610.75 | 1.64 | 3785.00 | 1838.42 | 91.59 |
| simd-budget8 | 12 | 8 | 654.11 | 1.53 | 3785.00 | 1839.56 | 91.59 |
| paged-budget8 | 12 | 8 | 667.03 | 1.50 | 3785.00 | 1225.65 | 91.59 |
| shared-hot | 12 | 8 | 697.33 | 1.43 | 3785.00 | 1004.18 | 91.59 |
| cached-stats-final | 20 | 8 | 654.16 | 1.53 | 3785.00 | 1055.69 | 91.59 |
| direct-stats-final | 20 | 8 | 658.05 | 1.52 | 3785.00 | 1052.19 | 91.59 |
| removed-cache-final | 20 | 8 | 659.08 | 1.52 | 3693.00 | 1051.01 | 0.00 |
| cached-monitored | 20 | 8 | 617.16 | 1.62 | 3785.00 | 1054.71 | 91.59 |
| removed-monitored | 20 | 8 | 692.93 | 1.44 | 3693.00 | 1051.57 | 0.00 |
| cached-budget4-monitored | 32 | 4 | 676.51 | 1.48 | 3785.00 | 1105.49 | 91.59 |
| removed-budget4-monitored | 32 | 4 | 637.39 | 1.57 | 3693.00 | 1103.31 | 0.00 |
| cached-final-monitored | 32 | 8 | 634.86 | 1.58 | 3785.00 | 1073.93 | 91.59 |
| removed-final-monitored | 32 | 8 | 704.32 | 1.42 | 3693.00 | 1069.66 | 0.00 |
| cached-compact-monitored | 32 | 8 | 644.22 | 1.55 | 3785.00 | 1067.54 | 91.59 |
| removed-compact-monitored | 32 | 8 | 690.45 | 1.45 | 3686.00 | 1074.97 | 0.00 |
| removed-rowcheck-monitored | 32 | 8 | 620.12 | 1.61 | 3686.00 | 1070.14 | 0.00 |
| cached-rowcheck-monitored | 32 | 8 | 633.75 | 1.58 | 3785.00 | 950.49 | 91.59 |

Measured Windows paging during tick windows (system-wide, competing applications included):

| Run | Process total page faults | Page reads/s | Page writes/s | Pages in/s | Pages out/s | Min available MiB |
|---|---:|---:|---:|---:|---:|---:|
| cached-monitored | 298871 | 275.88 | 43.06 | 7198.00 | 11067.25 | 492 |
| removed-monitored | 293904 | 305.25 | 0.19 | 9316.81 | 0.19 | 300 |
| cached-budget4-monitored | 400497 | 436.19 | 3.96 | 3815.88 | 792.38 | 215 |
| removed-budget4-monitored | 334099 | 263.32 | 0.28 | 4692.80 | 37.64 | 340 |
| cached-final-monitored | 436223 | 228.32 | 0.00 | 1543.36 | 0.00 | 213 |
| removed-final-monitored | 457724 | 204.44 | 0.11 | 4609.78 | 4.52 | 166 |
| cached-compact-monitored | 337501 | 155.24 | 0.00 | 432.96 | 0.00 | 252 |
| removed-compact-monitored | 457626 | 145.26 | 8.41 | 1602.70 | 2136.07 | 378 |
| removed-rowcheck-monitored | 374893 | 21.13 | 5.13 | 116.46 | 1208.25 | 417 |
| cached-rowcheck-monitored | 266204 | 158.14 | 0.00 | 1301.91 | 0.00 | 334 |

Page-fault values are total process faults on Windows, including soft faults. Hardware cache/DRAM traffic is unmeasured: WPR counter start returned access denied. The acquisition per-instance stat input falls from 32 bytes to 16 bytes per four units plus shared-row accesses; that is an access-size calculation, not measured bus traffic.
