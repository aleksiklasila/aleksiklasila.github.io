// Bytes a kernel allocates per replay of its dumped calls (kdump.js
// inputs, as kbench.cjs): run with a big young generation so no scavenge
// lands inside the measured replay.
//   node --max-semi-space-size=1024 .claude/kalloc.cjs <dumpdir> <KERNEL_NAME> [reps=6] [variant.js]
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), v8 = require('v8');
const dir = process.argv[2], name = process.argv[3], reps = +process.argv[4] || 6, variant = process.argv[5];
const src = {}, P = [];
let calls = null;
for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^(\d+)-(.+?)@(.+)\.(\w+Array)\.bin$/);
    if (!m || m[1] !== '1' || m[2] !== name) continue;
    const buf = fs.readFileSync(path.join(dir, f)), T = globalThis[m[4]];
    const arr = new T(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (m[3] === 'calls') calls = arr; else if (/^P\d+$/.test(m[3])) P[+m[3].slice(1)] = arr; else src[m[3]] = arr;
}
if (!calls) throw new Error('no dump for ' + name);
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8'), { filename: 'sim_parallel.js' });
if (variant) vm.runInThisContext(fs.readFileSync(variant, 'utf8'), { filename: variant });
const K = vm.runInThisContext(variant ? 'KBENCH_VARIANT' : 'SIM_KERNELS[' + name + ']');
const copy = () => { const R = {}; for (const k in src) R[k] = src[k].slice(); return R; };
for (let r = 0; r < reps; r++) {
    const R = copy();
    globalThis.gc && gc();
    const a = v8.getHeapStatistics().used_heap_size, t = process.hrtime.bigint();
    for (let i = 0; i < calls.length; i += 2) K(R, P[calls[i + 1]], calls[i]);
    const ms = Number(process.hrtime.bigint() - t) / 1e6, b = v8.getHeapStatistics().used_heap_size;
    console.log('rep', r, ((b - a) / 1048576).toFixed(2), 'MB', ms.toFixed(1), 'ms', 'calls', calls.length / 2);
}
