# Note
* If clients cannot find games created by the host:
  * This uses peerjs, and does not have turn, etc servers -> you may need to use tailscale (or something similar, google what fits you best) if one or more players are behind nat / firewalls from the point of view of any of the other players.

# Solo scene snapshots
* Both **Export Settings** and the offline **Export Snapshot** button open choices for **Uncompressed** (editable `.json`) or **Compressed** (`.gz` for compact sharing). **Play Offline** opens **New** and **Load**; loading accepts the portable scene snapshots. Both importers detect gzip from the file contents, including `.json.gz` files. Scene import also accepts older `.jsonl` / `.jsonl.gz` files and rebuilds the scene with the current game rules.
* Includes settings, seed, terrain/areas/mines, player resources and research levels, building types/tiles/stacks/health/rally destinations, unit types/positions/levels/stacks/health/move or attack-move destinations/hold orders, and camera position. Positions use tile units. Unit-target building rallies become the target's captured position.
* These are benchmark setups, not exact saved games: the clock restarts at zero, paths and AI are recomputed, and combat targets, projectiles, effects, production queues, pending input and internal simulation caches are omitted. The source tick is informational. Simulation rule revisions do not block import; removed unit/building types produce an explicit error.
* Scene schema version 1 is a standard JSON array: a `defence3-scene` header, bounded records containing `terrain`, `areas`, `mines`, `buildings` or `units`, then an `end` record with counts. Terrain rows contain runs of `[type, owner, areaId, count]`. Building rows are `[type, owner, gx, gy, stacks, energy, underConstruction, rallyX, rallyY, autoUpgrade, buildEnabled]`. Unit rows are `[type, owner, x, y, energy, baseLevel, stacks, order, hold]`, with `order` either null or `[move|attackMove, gx, gy]`. Compression and decompression use browser streams. Export and import never assemble the entire file into one string.
* Tests: `node tests/solo-snapshot.test.cjs`; scale/file round trip: `node --max-old-space-size=4096 tests/solo-scene-scale.test.cjs` (4 million unit records by default).

# Rust/WebAssembly kernels
* The heaviest simulation kernels (separation, acquisition scan) have Rust twins compiled to WebAssembly with SIMD (`wasm/src/lib.rs`). They are embedded in the generated `src/sim/sim_wasm_bin.js`.
* Rebuild after editing the Rust code (rustup + `rustup target add wasm32-unknown-unknown` once; on Windows: `winget install --id Rustlang.Rustup -e`):
  * `node wasm/build.cjs`
* Details, rules for the Rust code, switches and tests: [wasm/README.md](wasm/README.md).
* Local testing needs cross-origin isolation (shared memory): `python serve.py`.
