// Builds the Rust simulation kernels (wasm/src/lib.rs) and writes them into
// src/sim/sim_wasm_bin.js, which the game loads like any other script (the
// bytes as base64: no fetch, so workers, helpers and the node harness load
// it synchronously the same way).
//   node wasm/build.cjs            (from rng/defence3, or anywhere)
// Needs rustup's stable toolchain and the wasm32-unknown-unknown target (see
// wasm/README.md). The linked module imports its memory; it is patched here
// to import a *shared* memory (every helper thread instantiates the module
// over the one memory the simulation thread allocates its arrays in), which
// stable Rust cannot link itself without rebuilding core with atomics. The
// kernels use no atomics and no static data (checked below), so a shared
// memory changes nothing for them.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const here = __dirname;
const out = path.join(here, '..', 'src', 'sim', 'sim_wasm_bin.js');
const wasmPath = path.join(here, 'target', 'wasm32-unknown-unknown', 'release', 'defence3_sim.wasm');

// cargo from PATH, else rustup's default location.
const env = { ...process.env };
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
env.PATH = cargoBin + path.delimiter + (env.PATH || env.Path || '');
if (!process.argv.includes('--no-build')) {
    const r = cp.spawnSync('cargo', ['build', '--release'], { cwd: here, env, stdio: 'inherit', shell: process.platform === 'win32' });
    if (r.status !== 0) { console.error('cargo build failed (is rustup installed, with `rustup target add wasm32-unknown-unknown`?)'); process.exit(r.status || 1); }
}
// ---- wasm-opt (binaryen), when found: WASM_OPT, wasm/tools/binaryen-*/bin,
// or PATH. Speed passes (no fast-math: float results as written). Skipped
// with --no-wasm-opt or when not installed (the module works either way;
// the committed build is the optimized one).
function findWasmOpt() {
    const exe = process.platform === 'win32' ? 'wasm-opt.exe' : 'wasm-opt';
    if (process.env.WASM_OPT && fs.existsSync(process.env.WASM_OPT)) return process.env.WASM_OPT;
    const tools = path.join(here, 'tools');
    if (fs.existsSync(tools)) for (const d of fs.readdirSync(tools).sort().reverse()) {
        const f = path.join(tools, d, 'bin', exe);
        if (fs.existsSync(f)) return f;
    }
    const r = cp.spawnSync(exe, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
    return r.status === 0 ? exe : null;
}
const WASM_OPT_LEVEL = process.env.WASM_OPT_LEVEL || '-O3';
let wasmIn = wasmPath;
if (!process.argv.includes('--no-wasm-opt')) {
    const wo = findWasmOpt();
    if (wo) {
        const tmp = path.join(os.tmpdir(), 'defence3_sim.opt.' + process.pid + '.wasm');
        const args = [wasmPath, '-o', tmp, WASM_OPT_LEVEL, '--enable-simd', '--enable-threads', '--enable-bulk-memory', '--enable-nontrapping-float-to-int',
            '--enable-sign-ext', '--enable-mutable-globals', '--strip-debug', '--strip-producers'];
        if (process.argv.includes('--keep-names')) args.push('--debuginfo');
        const r = cp.spawnSync(wo, args, { stdio: 'inherit' });
        if (r.status !== 0) { console.error('wasm-opt failed'); process.exit(r.status || 1); }
        wasmIn = tmp;
        console.log('wasm-opt ' + WASM_OPT_LEVEL + ': ' + fs.statSync(wasmPath).size + ' -> ' + fs.statSync(tmp).size + ' bytes');
    } else console.log('(wasm-opt not found: the module as linked)');
}
const bytes = new Uint8Array(fs.readFileSync(wasmIn));
if (wasmIn !== wasmPath) fs.unlinkSync(wasmIn);

// ---- read the sections ----
function leb(buf, o) { let v = 0, s = 0, c; do { c = buf[o++]; v += (c & 127) * 2 ** s; s += 7; } while (c & 128); return [v, o]; }
const sections = [];
for (let o = 8; o < bytes.length;) {
    const id = bytes[o];
    const [size, body] = leb(bytes, o + 1);
    sections.push({ id, body, size });
    o = body + size;
}
if (sections.some(s => s.id === 11)) throw new Error('the module has data segments: every instantiation would rewrite them in the shared memory (no statics in lib.rs)');
// ---- the memory import: shared ----
const imp = sections.find(s => s.id === 2);
if (!imp) throw new Error('no import section');
let o = imp.body, patched = false;
let [count, p] = leb(bytes, o); o = p;
for (let i = 0; i < count; i++) {
    let [ml, a] = leb(bytes, o); o = a + ml;
    let [nl, b] = leb(bytes, o); const name = Buffer.from(bytes.subarray(b, b + nl)).toString(); o = b + nl;
    const kind = bytes[o++];
    if (kind === 0) { o = leb(bytes, o)[1]; continue; }
    if (kind === 1) { o++; const fl = bytes[o++]; o = leb(bytes, o)[1]; if (fl & 1) o = leb(bytes, o)[1]; continue; }
    if (kind === 3) { o += 2; continue; }
    if (kind !== 2) throw new Error('unexpected import kind ' + kind);
    if (name !== 'memory') throw new Error('unexpected memory import ' + name);
    const fl = bytes[o];
    if (fl === 3) { patched = true; break; }
    if (fl !== 1) throw new Error('memory import without a maximum (link with --max-memory)');
    bytes[o] = 3;
    patched = true;
    break;
}
if (!patched) throw new Error('memory import not found');

// ---- checks: it compiles, links to a shared memory, exports what the loader needs ----
const mod = new WebAssembly.Module(bytes);
const exp = WebAssembly.Module.exports(mod).map(e => e.name);
for (const need of ['__stack_pointer', '__heap_base']) if (!exp.includes(need)) throw new Error('missing export ' + need);
const memory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true });
const inst = new WebAssembly.Instance(mod, { env: { memory } });
const fns = exp.filter(n => typeof inst.exports[n] === 'function').sort();

const b64 = Buffer.from(bytes).toString('base64');
const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const lines = [];
for (let i = 0; i < b64.length; i += 120) lines.push("'" + b64.slice(i, i + 120) + "'");
const src = `"use strict";
// GENERATED by wasm/build.cjs from wasm/src/lib.rs: do not edit by hand.
// The simulation's Rust kernels (wasm32 + simd128; memory import shared),
// loaded by src/sim/sim_wasm.js. Exports: ${fns.join(', ')}.
const SIM_WASM_HASH = '${hash}';
const SIM_WASM_BIN = ${lines.join(' +\n    ')};
`;
fs.writeFileSync(out, src);
console.log(`wrote ${path.relative(process.cwd(), out)}: ${bytes.length} bytes, ${fns.length} kernels, hash ${hash}`);
