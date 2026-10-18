# Note
* If clients cannot find games created by the host:
  * This uses peerjs, and does not have turn, etc servers -> you may need to use tailscale (or something similar, google what fits you best) if one or more players are behind nat / firewalls from the point of view of any of the other players.

# Solo game snapshots
* In a solo match, **Export Snapshot** in the top bar downloads a JSON file. In the main menu, **Import Snapshot** resumes that saved scene.
* Files include the simulation tick, map, entities, resources, research, orders, queued input, random-generator state, runtime configuration, and camera position. Worker games are captured in the worker between ticks, after previously dispatched ticks finish.
* Keep the game revision with benchmark fixtures. Incompatible snapshot formats or simulation rules are rejected. The existing recovery codec rebuilds history-dependent simulation caches, rendering caches, visual fog history, particles, and audio; snapshots are reproducible simulation scenes, not recordings of these caches or screen effects. Solo pacing continues to adapt to the current machine after loading.
* Regression test: `node tests/solo-snapshot.test.cjs` (page and worker capture, import, repeatable continuation, and invalid files).

# Rust/WebAssembly kernels
* The heaviest simulation kernels (separation, acquisition scan) have Rust twins compiled to WebAssembly with SIMD (`wasm/src/lib.rs`). They are embedded in the generated `src/sim/sim_wasm_bin.js`.
* Rebuild after editing the Rust code (rustup + `rustup target add wasm32-unknown-unknown` once; on Windows: `winget install --id Rustlang.Rustup -e`):
  * `node wasm/build.cjs`
* Details, rules for the Rust code, switches and tests: [wasm/README.md](wasm/README.md).
* Local testing needs cross-origin isolation (shared memory): `python serve.py`.
