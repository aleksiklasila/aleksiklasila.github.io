// Rust kernel replay: one dumped kernel's calls of a tick (.claude/kdump.js,
// tickbench EVALALL + DUMPBIN) replayed in order on one thread over its
// arrays copied into the wasm heap, repeated (inputs refilled, not timed);
// a digest of what the replay writes. WASMBIN=path: another build's
// sim_wasm_bin.js (A/B of two builds on the same inputs).
//   node .claude/rbench.cjs <dumpdir> <KERNEL_NAME> [peer=1] [reps=10]
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = process.argv[2], name = process.argv[3], peer = process.argv[4] || '1', reps = +process.argv[5] || 10;
const SRC = path.join(__dirname, '../src/sim');
for (const f of ['sim_parallel.js', 'sim_wasm_bin.js', 'sim_wasm.js']) {
    const file = f === 'sim_wasm_bin.js' && process.env.WASMBIN ? process.env.WASMBIN : path.join(SRC, f);
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: f });
}
const G = vm.runInThisContext('({ reg: _simParReg, bind: simParallelBind, heap: simHeapArray, init: simWasmInit, K: SIM_KERNELS })');
if (!G.init()) throw new Error('no wasm');
const src = {}, P = [];
let calls = null;
for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(\d+)-(.+?)@(.+)\.(\w+Array)\.bin$/);
    if (!m || m[1] !== peer || m[2] !== name) continue;
    const buf = fs.readFileSync(path.join(dir, f)), T = globalThis[m[4]];
    const arr = new T(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (m[3] === 'calls') calls = arr;
    else if (/^P\d+$/.test(m[3])) P[+m[3].slice(1)] = arr;
    else src[m[3]] = arr;
}
if (!calls) { console.log(name, ': no dump in', dir); process.exit(1); }
const H = {};
for (const k in src) { H[k] = G.heap(src[k].constructor, Math.max(1, src[k].length)); G.bind(k, H[k]); }
const refill = () => { for (const k in src) H[k].set(src[k]); };
const fn = G.K[vm.runInThisContext(name)];
const replay = () => { for (let i = 0; i < calls.length; i += 2) fn(G.reg, P[calls[i + 1]], calls[i]); };
const t = [];
for (let r = 0; r < reps; r++) {
    refill();
    const t0 = process.hrtime.bigint(); replay(); t.push(Number(process.hrtime.bigint() - t0) / 1e6);
}
// What the replay changed: per array, how many bytes, and an FNV digest of all.
let h = 2166136261 >>> 0, changed = [];
for (const k of Object.keys(src).sort()) {
    const a = new Uint8Array(src[k].buffer, src[k].byteOffset, src[k].byteLength), b = new Uint8Array(H[k].buffer, H[k].byteOffset, src[k].byteLength);
    let n = 0;
    for (let i = 0; i < b.length; i++) { if (a[i] !== b[i]) n++; h = Math.imul(h ^ b[i], 16777619) >>> 0; }
    if (n) changed.push(k + ':' + n);
}
// SAVE=file: the written arrays kept; CMP=file: how many elements differ
// from those (another build's, the same inputs).
if (process.env.SAVE) { const o = {}; for (const k of Object.keys(src)) o[k] = Buffer.from(H[k].buffer, H[k].byteOffset, src[k].byteLength).toString('base64'); fs.writeFileSync(process.env.SAVE, JSON.stringify(o)); }
if (process.env.CMP) {
    const o = JSON.parse(fs.readFileSync(process.env.CMP, 'utf8')), diff = [];
    for (const k of Object.keys(src)) {
        if (!o[k]) continue;
        const b = Buffer.from(o[k], 'base64'), T = src[k].constructor, ref = new T(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        let n = 0;
        for (let i = 0; i < ref.length; i++) if (!(ref[i] === H[k][i] || (ref[i] !== ref[i] && H[k][i] !== H[k][i]))) n++;
        if (n) diff.push(k + ':' + n);
    }
    console.log('vs', process.env.CMP, diff.length ? 'differ ' + diff.join(' ') : 'identical');
}
// ARGW=a,b: argument block words to print (kernel debug counters).
if (process.env.ARGW) console.log('argw', process.env.ARGW.split(',').map(i => vm.runInThisContext('_simWasmArgI')[+i]));
const s = t.slice().sort((x, y) => x - y);
console.log(`${name} calls ${calls.length / 2}  median ${s[s.length >> 1].toFixed(2)} ms  min ${s[0].toFixed(2)}  digest ${h.toString(16)}  writes ${changed.join(' ')}`);
