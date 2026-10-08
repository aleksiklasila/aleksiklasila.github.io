# Note
* If clients cannot find games created by the host:
  * This uses peerjs, and does not have turn, etc servers -> you may need to use tailscale (or something similar, google what fits you best) if one or more players are behind nat / firewalls from the point of view of any of the other players.

# Rust/WebAssembly kernels
* The heaviest simulation kernels (separation, acquisition scan) have Rust twins compiled to WebAssembly with SIMD (`wasm/src/lib.rs`). They are embedded in the generated `src/sim/sim_wasm_bin.js`.
* Rebuild after editing the Rust code (rustup + `rustup target add wasm32-unknown-unknown` once; on Windows: `winget install --id Rustlang.Rustup -e`):
  * `node wasm/build.cjs`
* Details, rules for the Rust code, switches and tests: [wasm/README.md](wasm/README.md).
* Local testing needs cross-origin isolation (shared memory): `python serve.py`.
