# Occupancy movement experiment, 2026-10-21

The current opt-in implementation checks occupancy at the movement position
write. The WASM movement jobs run in four checkerboard phases over spatial
blocks. Each accepted footprint change clears the old disk and paints the
new disk before another unit in that job moves. Unchanged footprints do not
write the bitmap. There is no occupancy proposal buffer or occupancy commit
kernel/pass. JS movement uses the same immediate operation at coordinate
writes. Spawning paints once; removal clears once.

`simMoveRun()` orchestrates movement: combat/navigation inputs, movement
dispatch, path-cost charges, spatial updates and exceptional results.
`simParallelRun(kernel, jobs)` is the generic worker scheduler called by
movement and many other stages. Its movement timings are included in
`simMoveRun`, not an additional movement pass. Four scheduler calls execute
the four spatial colours. `occupancyPrepareMovement` reads tile counts to
reserve per-job hit/post output ranges; it does not traverse units or touch
the occupancy bitmap.

## Radius code

`wasm/generate-occ-shapes.cjs` generates check, paint and clear bodies for
all radii 1–10 subcells (4–40 pixels at the current configuration). Current
unit definitions need only radii 1–3; a tile is 32 pixels. Larger prototype
radii retain the generic fallback.

Rows use unaligned 64-bit masks, with one padding word per map row. Position
to subcell conversion uses shifts. The old footprint is excluded with masked
rotations; distance gates prevent rotation/SIMD lookup wrap from excluding
unrelated cells on long sweeps. Larger shapes use constant SIMD swizzles for
old-row widths. Painting/clearing writes only 64 bits per row, not a wider
SIMD store that could interfere with a neighbouring helper's words.

The production optimized WASM was inspected, not just the Rust source:

- WASM32: all 30 shape bodies have zero `if`, `br_if`, `br_table`, or `loop`.
  The common radius-2 body checks three 64-bit loads; paint/clear each use
  three loads and three stores.
- WASM64: Binaryen inlines those bodies into the three radius dispatchers.
  Each dispatcher has one radius-selection `br_table`, zero `if`, zero
  `br_if`, and zero loops. The per-radius bodies remain straight-line.
- Details: `shape-instructions.json`, `shape-instructions64.json`,
  `final.wat`, `final64.wat`.

## 4M checkerboard runs

All runs use the exclusive one-plane, legal packed layout, map 1024, seven
helpers, dk=1, three warmup ticks and 16 measured ticks, with the main-thread
CPU profiler enabled. The original pair-collision reference was not rerun.

| Occupancy implementation | Mean tick ms | Median ms | Movement orchestration ms | Scheduled movement ms | Separate occupancy pass ms |
|---|---:|---:|---:|---:|---:|
| Initial occupancy prototype (`one-plane.json`) | 352.64 | 283.45 | 107.06 | see raw report | 69.44 |
| First fused implementation (`fused-one-plane.json`) | 329.50 | 258.86 | 175.38 | 122.43 | 0 |
| Cross-tile SIMD grouping experiment (`grouped-one-plane.json`) | 375.05 | 320.29 | 203.29 | 146.46 | 0 |
| Final branch-free shapes (`final-one-plane.json`) | 377.99 | 306.38 | 199.51 | 134.99 | 0 |

These are short individual runs with considerable tick variation, not a
statistically established speedup. The grouping experiment recovered 862,772
four-unit groups in its last tick but added membership checks and extra index
reads; it was removed. The final source retains the simpler spatial walk.
Many tile entries split the existing contiguous SIMD mover into scalar work.

The final movement stage's 199.51 ms includes its 134.99 ms of scheduled
movement jobs, 7.28 ms of tile-count/output-range preparation, and its combat
scan/setup/result handling. These nested numbers must not be added as
independent phases. Main-thread CPU samples put `move_pre` and `move_job`
above occupancy `MoveGrid::position`; the workload is not just disk painting.
Hardware cache-miss/bandwidth counters were not collected, so these samples
do not establish whether the scalar work is memory-bound.

The final grid is 8.03125 MiB. Four million units spawn without relocation or
rejection; 3,881,384 remain registered after combat. The final audit finds
34,932,456 actual bits, exactly matching expected bits, and zero mismatches
between live coordinates and painted coordinates. Last-tick counters:
668,176 position attempts, 71,608 accepted position changes, 666,159 blocked
or clipped attempts, and 1,250 footprint changes. Accepted changes can be
partial; most movement is blocked in this packed scene. This benchmark does
not establish uncongested movement throughput.

## Validation

- `tests/occupancy-shapes.test.cjs`: 640 independent bitmap-oracle cases on
  both WASM32 and WASM64, all ten radii, word seams, map edges, old-footprint
  exclusion, long swept moves, blockers and exact release.
- `tests/occupancy-grid.test.cjs`: immediate coordinate writes, zero
  overlapping footprints, before-pass-end audits, real game ticks with zero
  and seven helpers, one and three planes, removal, and no pair-separation
  buffers.
- 40K real-helper smoke benchmark and final 4M bitmap/coordinate audits pass.
- Kernel and storage ABI checks pass. Existing movement replay matches its
  reference on 18 chunks at dk 1/4/20 with occupancy disabled.
- Final embedded builds: WASM64 `a996b87479c54106`; WASM32
  `2cab53dc8f679662`.
