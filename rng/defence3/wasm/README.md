# Rust/WebAssembly simulation kernels

Every simulation kernel is Rust (`src/lib.rs`, `src/k.rs`, `src/mv.rs`,
`src/rebase.rs`), compiled to WebAssembly with SIMD (`simd128`): the
separation passes, acquisition, the movement kernel family, flow navigation
rows, effective stats, the state hash's unit part and the rest of the
`SIM_KERNEL_*` jobs (sim_parallel.js calls them through `_simRust`).

**There are no JavaScript versions and no fallback.** A page needs
WebAssembly with a shared memory, so a cross-origin isolated page
(`coi-serviceworker.min.js` in production, `python serve.py` locally): the
HUD says so when the page is not isolated, and a match cannot run there. A
kernel that cannot run (no module, an array outside the heap) is an error
(`_simNoWasm`), not a silent JS path. (Earlier versions had JS twins that
matched the Rust bit for bit and ran when wasm was missing; they were
removed, and with them that fallback.)

Lockstep needs the kernels to be deterministic, not to match any JS: the
same inputs give the same outputs on every peer, thread count and engine.
WebAssembly's float operations (including `sqrt`) are IEEE 754's, exactly
specified; the kernels use standard SIMD only (no relaxed SIMD, whose
results may differ by machine) and no fused multiply-add.

## How it is wired

* `src/sim/sim_wasm.js` creates one shared `WebAssembly.Memory` (the "heap")
  in the simulation worker. The arrays these kernels read (unit columns, the
  unit index, the separation and acquisition buffers, the wall and area
  grids) are allocated in it with `simHeapArray`, so the kernels work on the
  game's own arrays in place, with no copies.
* Each helper thread instantiates the module over the same memory, with its
  own stack and scratch region (`simParallelInit` sends it the module, the
  memory, a 256 KB stack and 4 MB of scratch for work arrays).
* Freed arrays (`simHeapFree`, or a FinalizationRegistry for arrays whose
  owners the collector drops, such as old unit columns and the flow
  navigation's graph copies) are reused only once every background job in
  flight when they were freed is done, at least 2 ticks later, and no name
  binds them. Wasm memory never shrinks: `simUnitStateReserve` sizes the
  unit columns once before bulk creation (match start, restore) instead of
  growing them step by step.
* `simParallelBind` records each array's address; a kernel job passes the
  addresses of its arrays to the Rust function (`_simRust`), which every
  thread of the simulation runs over the same heap.
* The compiled module is embedded in `src/sim/sim_wasm_bin.js` as base64, so
  workers, helpers and the node test harness load it synchronously like any
  other script. **That file is generated: rebuild it after editing
  `src/lib.rs`.**

## Building

One-time setup (Windows, PowerShell):

```powershell
winget install --id Rustlang.Rustup -e
rustup target add wasm32-unknown-unknown
```

On macOS/Linux, install rustup from https://rustup.rs, then run the same
`rustup target add wasm32-unknown-unknown`.

Build (from `rng/defence3`):

```bash
node wasm/build.cjs
```

This runs `cargo build --release` for `wasm32-unknown-unknown` with
`simd128` (flags in `.cargo/config.toml`). It then patches the module's
memory import to *shared* (stable Rust cannot link a shared memory without
rebuilding `core`), checks that the module has no data segments and links to
a shared memory, and writes `src/sim/sim_wasm_bin.js`.
`node wasm/build.cjs --no-build` repackages an existing build.

Between cargo and the patch it runs binaryen's `wasm-opt -O3` (SIMD,
threads, bulk memory, non-trapping float-to-int, sign-ext, mutable globals;
no fast-math) when it finds it: `WASM_OPT=path`, `wasm/tools/binaryen-*/bin/`
(gitignored: unpack a release from
https://github.com/WebAssembly/binaryen/releases there), or `PATH`. Without
it the module is used as linked. The committed `sim_wasm_bin.js` is the
optimized build (MOVE replay ~3-6% faster than without, same outputs).
`--no-wasm-opt` skips it; `WASM_OPT_LEVEL=-O4` picks another level;
`--keep-names` keeps function names (profiles).

No Visual Studio / MSVC is needed: the crate has no dependencies and links
with the bundled `rust-lld`.

### Rules for `src/lib.rs`

* `#![no_std]`, no statics, no allocation, and no integer `/` or `%` that can
  panic (use `idiv`/`irem`). The module must have no data segments, because
  every helper's instantiation would rewrite them in the shared memory
  (`build.cjs` refuses such a module).
* Deterministic, not JS-like: native f32/f64/integer math, any data layout
  or SIMD, as long as the result depends only on the inputs (never on the
  thread count, the chunking, memory not written, or relaxed SIMD). No fused
  multiply-add (`mul_add`), which some targets lower otherwise.
* A change of what a kernel computes is a rules change: bump
  `SIM_RULES_REVISION` (src/utils/utils_snapshot.js).
* Checks: `node tests/storage-abi.test.cjs` (the Rust pointer types against
  the JS column types), the kernel tests (`tests/*-kernel*.test.cjs`,
  `parallel-kernels`, `shared-kernel-threads`), and the multiplayer
  determinism suites (`tests/multiplayer-chaos-determinism.test.cjs` with
  real helper threads, `multiplayer-cross-engine`).

## Switches and checks

* `simHeapStats()` shows the heap in use.
* Do not set `SIM_WASM_ENABLED = false` or call `simWasmKernels(false)` to
  "fall back": there is nothing to fall back to, the kernels then fail.
* Tick benchmark (`.claude/tickbench.cjs`, a host and a guest over the test
  network): `desyncs` and `patches` must stay 0.

* Local browser runs need cross-origin isolation for the shared memory:
  serve with `python serve.py` (not `python -m http.server`).
