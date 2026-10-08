# Rust/WebAssembly simulation kernels

The heaviest simulation kernels have Rust twins in `src/lib.rs`, compiled to
WebAssembly with SIMD (`simd128`):

| Rust function | JS twin                                          | What it does |
|---------------|--------------------------------------------------|--------------|
| `sep_pack`    | `SIM_KERNEL_SEP_PACK` (sim_parallel.js)          | separation: the unit index's entries packed (SoA, Float32) |
| `sep_mark`    | `SIM_KERNEL_SEP_MARK`                            | separation: units at rest next to movers take part (a byte table of "moved" chunks) |
| `sep_pairs`   | `SIM_KERNEL_SEP_PAIRS`                           | separation: every touching pair, found by the unit taking part; neighbour runs from a table of chunk starts, candidates tested four at a time (f32x4 prefilter, exact f64 test) |
| `sep_finish`  | `SIM_KERNEL_SEPARATION_FINISH`                   | separation: apply the summed pushes (idle slots four at a time) |
| `acq_omt`, `acq_pack` | `SIM_KERNEL_ACQ_OMT`                     | acquisition tier's first stage: owners per chunk transposed, the index's entries packed in its order |
| `acq_scan`    | `SIM_KERNEL_ACQ_SCAN`                            | acquisition tier: nearest enemy (rings scanned 16 chunks at a time) and structure (16 tiles at a time) |
| `nav_row`     | `_navFieldRow` (game/flownav.js)                 | flow navigation: a destination's row (Dijkstra over the exit graph) |

Each Rust kernel writes exactly what its JS twin writes, bit for bit, so
either one may run any chunk on any thread. Peers with and without wasm stay
in lockstep. The JS kernels are the fallback: they run when the page is not
cross-origin isolated, when the module fails to load, or when an array is not
in the wasm heap. Where the Rust kernel walks differently (other culls, other
order), it is because the result does not depend on it: the same pairs, the
same nearest target; a twin may not change *which* pairs or targets count.

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
* `simParallelBind` records each array's address; a JS kernel calls its Rust
  twin when this thread has the module and all its arrays are in the heap.
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

No Visual Studio / MSVC is needed: the crate has no dependencies and links
with the bundled `rust-lld`.

### Rules for `src/lib.rs`

* `#![no_std]`, no statics, no allocation, and no integer `/` or `%` that can
  panic (use `idiv`/`irem`). The module must have no data segments, because
  every helper's instantiation would rewrite them in the shared memory
  (`build.cjs` refuses such a module).
* Match JavaScript number semantics where they show: `js_round` (Math.round),
  `js_max`, `to_i32` (ToInt32), `f32` stores, `||` on numbers. Do the
  operations in the same order as the JS code (no fused multiply-add).
* Change a kernel's JS twin and its Rust twin together, then check that they
  still agree:

```bash
node tests/wasm-kernels.test.cjs 8
node tests/separation-pairs.test.cjs
```

## Switches and checks

* `SIM_WASM_ENABLED = false` (before a match): no heap, JS kernels only.
* `simWasmKernels(false)` / `simWasmKernels(true)`: switch the kernels on
  every thread of a running simulation (the heap stays). `simHeapStats()`
  shows the memory in use.
* Tick benchmark: `WASM=0` runs every peer on the JS kernels, and
  `WASM_GUEST=0` runs only the guest on JS, which checks lockstep between a
  wasm host and a JS guest (`desyncs` must stay 0):

```bash
DATA=tests/100000-1000.json HELPERS=7 ACTIVE=1 BATTLE=mix WASM_GUEST=0 node --max-old-space-size=12000 .claude/tickbench.cjs 8
```

* Local browser runs need cross-origin isolation for the shared memory:
  serve with `python serve.py` (not `python -m http.server`).
