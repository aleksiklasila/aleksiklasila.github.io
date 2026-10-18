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
// --wasm64: the memory64 build (the heap past 4 GiB: millions of units), for
// browsers, into src/sim/sim_wasm64_bin.js. Needs the nightly toolchain with
// rust-src (core is built for wasm64: -Zbuild-std). Addresses in the kernels'
// 32-bit words are then in 4-byte units (lib.rs waddr); the exports' pointer
// and usize parameters are i64 (BigInt from JavaScript: SIM_WASM64_I64 lists
// them, read from the module's types below).
const W64 = process.argv.includes('--wasm64');
const out = path.join(here, '..', 'src', 'sim', W64 ? 'sim_wasm64_bin.js' : 'sim_wasm_bin.js');
const wasmPath = W64 ? path.join(here, 'target64', 'wasm64-unknown-unknown', 'release', 'defence3_sim.wasm')
    : path.join(here, 'target', 'wasm32-unknown-unknown', 'release', 'defence3_sim.wasm');

// cargo from PATH, else rustup's default location.
const env = { ...process.env };
const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
env.PATH = cargoBin + path.delimiter + (env.PATH || env.Path || '');
if (!process.argv.includes('--no-build')) {
    const args = W64 ? ['+nightly', 'build', '--release', '--target', 'wasm64-unknown-unknown', '-Zbuild-std=core,panic_abort', '--target-dir', 'target64'] : ['build', '--release'];
    // (--features=a,b: cargo features, e.g. prof (the movement passes as functions, with --keep-names for profiles by pass).)
    const feat = process.argv.find(x => x.startsWith('--features='));
    if (feat) args.push('--features', feat.slice(11));
    // (--keep-names: the function names kept, for profiles: not stripped.)
    if (process.argv.includes('--keep-names')) env.CARGO_PROFILE_RELEASE_STRIP = 'false';
    const r = cp.spawnSync('cargo', args, { cwd: here, env, stdio: 'inherit', shell: process.platform === 'win32' });
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
        if (W64) args.push('--enable-memory64');
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
    // (Limits flags: 1 a maximum, 2 shared, 4 64-bit addresses.)
    const fl = bytes[o], want = W64 ? 7 : 3;
    if (fl === want) { patched = true; break; }
    if ((fl & ~2) !== (W64 ? 5 : 1)) throw new Error('memory import flags ' + fl + ' (link with --max-memory' + (W64 ? ', for wasm64' : '') + ')');
    bytes[o] = want;
    patched = true;
    break;
}
if (!patched) throw new Error('memory import not found');

// ---- the exports' parameter types (wasm64: which take i64) ----
function readTypes() {
    const types = [], funcTypes = [];
    const T = sections.find(s => s.id === 1), F = sections.find(s => s.id === 3), E = sections.find(s => s.id === 7), I = sections.find(s => s.id === 2);
    let [n, q] = leb(bytes, T.body);
    for (let i = 0; i < n; i++) {
        q++; // 0x60: a function type
        let [np, a] = leb(bytes, q); q = a;
        const params = Array.from(bytes.subarray(q, q + np)); q += np;
        let [nr, b] = leb(bytes, q); q = b + nr;
        types.push(params);
    }
    let [ni, qi] = leb(bytes, I.body);
    for (let i = 0; i < ni; i++) {
        let [ml, a] = leb(bytes, qi); qi = a + ml;
        let [nl2, b] = leb(bytes, qi); qi = b + nl2;
        const kind = bytes[qi++];
        if (kind === 0) { const [t, c] = leb(bytes, qi); funcTypes.push(t); qi = c; }
        else if (kind === 1) { qi++; const f = bytes[qi++]; qi = leb(bytes, qi)[1]; if (f & 1) qi = leb(bytes, qi)[1]; }
        else if (kind === 2) { const f = bytes[qi++]; qi = leb(bytes, qi)[1]; if (f & 1) qi = leb(bytes, qi)[1]; }
        else if (kind === 3) qi += 2;
    }
    let [nf, qf] = leb(bytes, F.body);
    for (let i = 0; i < nf; i++) { const [t, c] = leb(bytes, qf); funcTypes.push(t); qf = c; }
    const res = {};
    let [ne, qe] = leb(bytes, E.body);
    for (let i = 0; i < ne; i++) {
        let [l, a] = leb(bytes, qe); const name = Buffer.from(bytes.subarray(a, a + l)).toString(); qe = a + l;
        const kind = bytes[qe++]; const [idx, c] = leb(bytes, qe); qe = c;
        if (kind !== 0) continue;
        const params = types[funcTypes[idx]] || [];
        const i64 = params.map((t, k) => t === 0x7e ? k : -1).filter(k => k >= 0);
        if (i64.length) res[name] = i64;
    }
    return res;
}
const i64Params = W64 ? readTypes() : null;
// ---- checks: it compiles, links to a shared memory, exports what the loader needs ----
let fns;
if (W64) {
    // (Node's V8 compiles memory64 behind a flag, with the older API.)
    const tmp = path.join(os.tmpdir(), 'defence3_sim64.' + process.pid + '.wasm');
    fs.writeFileSync(tmp, bytes);
    const check = 'const m = new WebAssembly.Module(require("fs").readFileSync(' + JSON.stringify(tmp) + '));'
        + 'const memory = new WebAssembly.Memory({ initial: 256, maximum: 262144, index: "i64", shared: true });'
        + 'const inst = new WebAssembly.Instance(m, { env: { memory } });'
        + 'const exp = WebAssembly.Module.exports(m).map(e => e.name);'
        + 'for (const need of ["__stack_pointer", "__heap_base"]) if (!exp.includes(need)) throw new Error("missing export " + need);'
        + 'console.log(JSON.stringify(exp.filter(n => typeof inst.exports[n] === "function").sort()));';
    const r = cp.spawnSync(process.execPath, ['--experimental-wasm-memory64', '-e', check], { encoding: 'utf8' });
    fs.unlinkSync(tmp);
    if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
    fns = JSON.parse(r.stdout.trim().split('\n').pop());
} else {
    const mod = new WebAssembly.Module(bytes);
    const exp = WebAssembly.Module.exports(mod).map(e => e.name);
    for (const need of ['__stack_pointer', '__heap_base']) if (!exp.includes(need)) throw new Error('missing export ' + need);
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 65536, shared: true });
    const inst = new WebAssembly.Instance(mod, { env: { memory } });
    fns = exp.filter(n => typeof inst.exports[n] === 'function').sort();
}

const b64 = Buffer.from(bytes).toString('base64');
const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const lines = [];
for (let i = 0; i < b64.length; i += 120) lines.push("'" + b64.slice(i, i + 120) + "'");
const P = W64 ? 'SIM_WASM64' : 'SIM_WASM';
const src = `"use strict";
// GENERATED by wasm/build.cjs from wasm/src/lib.rs: do not edit by hand.
// The simulation's Rust kernels (${W64 ? 'wasm64: memory64' : 'wasm32'} + simd128; memory import shared),
// loaded by src/sim/sim_wasm.js. Exports: ${fns.join(', ')}.
const ${P}_HASH = '${hash}';
${W64 ? 'const SIM_WASM64_I64 = ' + JSON.stringify(i64Params) + ';\n' : ''}const ${P}_BIN = ${lines.join(' +\n    ')};
`;
fs.writeFileSync(out, src);
console.log(`wrote ${path.relative(process.cwd(), out)}: ${bytes.length} bytes, ${fns.length} kernels, hash ${hash}`);
