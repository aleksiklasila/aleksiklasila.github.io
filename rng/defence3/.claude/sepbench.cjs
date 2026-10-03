// Standalone timing of the separation pair stage on dumped inputs
// (.claude/sepdump.js + tickbench DUMPBIN): the kernel from
// src/sim/sim_parallel.js (loaded in a context of its own), every job of
// both parities serially, repeated; with VARIANT=file.js, a replacement
// kernel (assigning globalThis.SEP_PAIRS_VARIANT) timed and its sums
// compared with the original's by slot.
//   node .claude/sepbench.cjs <dumpdir> [peer=1] [reps=10]
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const dir = process.argv[2], peer = process.argv[3] || '1', reps = +process.argv[4] || 10;
const R = {};
for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(\d+)-(.+)\.(\w+Array)\.bin$/);
    if (!m || m[1] !== peer) continue;
    const buf = fs.readFileSync(path.join(dir, f)), T = globalThis[m[3]];
    R[m[2].replace('_', '.')] = new T(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}
const P0 = R.P0, P1 = R.P1;
// (The real global: a vm context's sandboxed globals (Math...) are slow.)
const ctx = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8'), { filename: 'sim_parallel.js' });
const K = vm.runInThisContext('SIM_KERNELS[SIM_KERNEL_SEP_PAIRS]');
const CH = P0[1] | 0, H = P0[2] | 0, bands = Math.ceil(CH / H), jobs0 = Math.ceil(bands / 2), jobs1 = Math.floor(bands / 2);
const outNames = ['sep.px', 'sep.py', 'sep.ov', 'sep.hit'];
const fresh = () => { for (const k of outNames) R[k].fill(0); };
const run = (fn) => { for (let c = 0; c < jobs0; c++) fn(R, P0, c); for (let c = 0; c < jobs1; c++) fn(R, P1, c); };
const time = (name, fn, pre, post) => {
    const ts = [];
    for (let i = 0; i < reps; i++) { fresh(); const a = process.hrtime.bigint(); if (pre) pre(R, P0); run(fn); if (post) post(R, P0); ts.push(Number(process.hrtime.bigint() - a) / 1e6); }
    ts.sort((a, b) => a - b);
    console.log(name.padEnd(10), 'median', ts[ts.length >> 1].toFixed(2), 'ms  min', ts[0].toFixed(2), 'ms');
};
console.log('entries', R['ix.listed'] ? R['ix.listed'][0] : P0[9], 'chunks', P0[0], 'x', P0[1], 'band rows', H, 'jobs', jobs0, '+', jobs1);
time('original', K);
fresh(); run(K);
const want = outNames.map(k => R[k].slice());
if (process.env.VARIANT) {
    vm.runInThisContext(fs.readFileSync(process.env.VARIANT, 'utf8'), { filename: process.env.VARIANT });
    const V = ctx.SEP_PAIRS_VARIANT;
    time('variant', V, ctx.SEP_PAIRS_VARIANT_PREP, ctx.SEP_PAIRS_VARIANT_POST);
    fresh(); if (ctx.SEP_PAIRS_VARIANT_PREP) ctx.SEP_PAIRS_VARIANT_PREP(R, P0); run(V); if (ctx.SEP_PAIRS_VARIANT_POST) ctx.SEP_PAIRS_VARIANT_POST(R, P0);
    let bad = 0;
    outNames.forEach((k, j) => { const a = want[j], b = R[k]; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { if (bad++ < 5) console.log('differs', k, i, a[i], b[i]); } });
    console.log(bad ? 'DIFFERENT: ' + bad : 'outputs equal');
}
