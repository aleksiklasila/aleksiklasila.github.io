// Standalone timing of one kernel on inputs dumped by .claude/kdump.js
// (tickbench EVALALL + DUMPBIN): its calls of that tick replayed in order on
// fresh copies of the inputs, repeated. VARIANT=file.js: a replacement
// (assigning KBENCH_VARIANT, optional KBENCH_PREP(R) / KBENCH_POST(R)) timed
// the same way; every array either run writes compared after one replay.
//   node .claude/kbench.cjs <dumpdir> <KERNEL_NAME> [peer=1] [reps=10]
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = process.argv[2], name = process.argv[3], peer = process.argv[4] || '1', reps = +process.argv[5] || 10;
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
if (!calls) throw new Error('no dump for ' + name);
// (The real global: a vm context's sandboxed globals (Math...) are slow.)
const ctx = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8'), { filename: 'sim_parallel.js' });
const K = vm.runInThisContext('SIM_KERNELS[' + name + ']');
const copy = () => { const R = {}; for (const k in src) R[k] = src[k].slice(); return R; };
const replay = (fn, R) => { for (let i = 0; i < calls.length; i += 2) fn(R, P[calls[i + 1]], calls[i]); };
const time = (label, fn, prep, post) => {
    const ts = [];
    for (let i = 0; i < reps; i++) { const R = copy(); const a = process.hrtime.bigint(); if (prep) prep(R); replay(fn, R); if (post) post(R); ts.push(Number(process.hrtime.bigint() - a) / 1e6); }
    ts.sort((a, b) => a - b);
    console.log(label.padEnd(10), 'median', ts[ts.length >> 1].toFixed(2), 'ms  min', ts[0].toFixed(2), 'ms');
};
console.log(name, 'calls', calls.length / 2, 'param sets', P.length, 'arrays', Object.keys(src).length, Object.keys(src).map(k => k + ':' + src[k].length).join(' '));
time('original', K);
if (process.env.VARIANT) {
    vm.runInThisContext(fs.readFileSync(process.env.VARIANT, 'utf8'), { filename: process.env.VARIANT });
    time('variant', ctx.KBENCH_VARIANT, ctx.KBENCH_PREP, ctx.KBENCH_POST);
    const A = copy(), B = copy();
    replay(K, A);
    if (ctx.KBENCH_PREP) ctx.KBENCH_PREP(B); replay(ctx.KBENCH_VARIANT, B); if (ctx.KBENCH_POST) ctx.KBENCH_POST(B);
    let bad = 0;
    // (KBENCH_IGNORE=a,b: arrays the variant may leave differently, e.g. scratch only read in part.)
    const ignore = new Set((process.env.KBENCH_IGNORE || '').split(',').filter(Boolean));
    for (const k in A) { if (ignore.has(k)) continue; const a = A[k], b = B[k]; for (let i = 0; i < a.length; i++) if (!(a[i] === b[i] || (a[i] !== a[i] && b[i] !== b[i]))) { if (bad++ < 8) console.log('differs', k, i, a[i], b[i]); } }
    console.log(bad ? 'DIFFERENT: ' + bad : 'outputs equal');
}
