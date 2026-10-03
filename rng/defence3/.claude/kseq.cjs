// Replays one kernel's dumped ticks (.claude/kdump2.js) in order on one
// thread, as a helper meets them: each tick's calls on fresh copies of its
// inputs, timed; ticks listed twice run twice (e.g. warm-up). With
// --trace-deopt --allow-natives-syntax the V8 trace and the tick markers
// share one stream (in order).
//   node [--trace-deopt --allow-natives-syntax] .claude/kseq.cjs <dumpdir> <KERNEL_NAME> <t1,t1,t1,t2,...>
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const [dir, name, seq] = process.argv.slice(2);
const sets = new Map();
for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^1-(.+?)~(\d+)@(.+)\.(\w+Array)\.bin$/);
    if (!m || m[1] !== name) continue;
    const buf = fs.readFileSync(path.join(dir, f)), T = globalThis[m[4]];
    const arr = new T(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const s = sets.get(+m[2]) || { src: {}, P: [], calls: null }; sets.set(+m[2], s);
    if (m[3] === 'calls') s.calls = arr; else if (/^P\d+$/.test(m[3])) s.P[+m[3].slice(1)] = arr; else s.src[m[3]] = arr;
}
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8'), { filename: 'sim_parallel.js' });
// (VARIANT=file.js: its KBENCH_VARIANT replayed instead.)
if (process.env.VARIANT) vm.runInThisContext(fs.readFileSync(process.env.VARIANT, 'utf8'), { filename: process.env.VARIANT });
const K = process.env.VARIANT ? globalThis.KBENCH_VARIANT : vm.runInThisContext('SIM_KERNELS[' + name + ']');
let mark = () => {};
try { mark = new Function('s', '%DebugPrint(s)'); } catch {}
for (const t of seq.split(',').map(Number)) {
    const s = sets.get(t);
    if (!s || !s.calls) { console.log('no dump for tick', t); continue; }
    const R = {}; for (const k in s.src) R[k] = s.src[k].slice();
    mark('REPLAY-TICK-' + t);
    const a = process.hrtime.bigint();
    for (let i = 0; i < s.calls.length; i += 2) K(R, s.P[s.calls[i + 1]], s.calls[i]);
    const ms = Number(process.hrtime.bigint() - a) / 1e6;
    mark('REPLAY-DONE-' + t + '-' + ms.toFixed(1) + 'ms');
    console.log('tick', t, ms.toFixed(1), 'ms', s.calls.length / 2, 'calls');
}
