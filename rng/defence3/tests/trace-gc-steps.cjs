'use strict';
// The simulation worker's garbage collection by step: a Chrome trace of a
// rendered run (.claude/scene_tps_probe.cjs TRACE=<file>, TRACE_CATS=
// devtools.timeline,blink.user_timing,disabled-by-default-v8.gc; QUERY=simtrace=1
// so the worker marks each step, sim_worker.js 'simstep <tick>') beside the
// probe's SIMTRACE output (DUMP=tests/perf-fuzz/simtrace-dump.js).
// Prints per step the worker thread's MinorGC / MajorGC time, the steps whose
// GC was over GCMIN ms (default 5), and how much of the slow steps' excess
// (over their 17-step window median) the collector explains.
//   node tests/trace-gc-steps.cjs <trace.json> <probe-output.txt> [GCMIN]
const fs = require('node:fs');
const trace = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ev = Array.isArray(trace) ? trace : trace.traceEvents;
let text = fs.readFileSync(process.argv[3], 'utf8').replace(/^﻿/, '');
const R = JSON.parse(text.split(/\r?\n/).find(l => l.startsWith('SIMTRACE ')).slice(9));
const gcMin = Number(process.argv[4]) || 5;
const marks = ev.filter(e => typeof e.name === 'string' && e.name.startsWith('simstep '));
if (!marks.length) throw new Error('no simstep marks: TRACE_CATS needs blink.user_timing, QUERY simtrace=1');
const tid = marks[0].tid, pid = marks[0].pid;
const at = new Map(); for (const m of marks) if (m.tid === tid && m.pid === pid) at.set(Number(m.name.slice(8)), m.ts);
const gcs = ev.filter(e => e.pid === pid && e.tid === tid && e.ph === 'X' && (e.name === 'MinorGC' || e.name === 'MajorGC')).sort((a, b) => a.ts - b.ts);
console.log('worker thread', pid, tid, 'marks', at.size, 'GC events', gcs.length, 'MajorGC', gcs.filter(g => g.name === 'MajorGC').length,
    'GC ms', (gcs.reduce((s, g) => s + g.dur, 0) / 1000).toFixed(0), 'longest', (Math.max(0, ...gcs.map(g => g.dur)) / 1000).toFixed(1));
const ticks = [...at.keys()].sort((a, b) => a - b);
const gcOf = new Map();
for (let i = 0; i < ticks.length; i++) {
    const t0 = at.get(ticks[i]), t1 = i + 1 < ticks.length ? at.get(ticks[i + 1]) : Infinity;
    let ms = 0, major = 0;
    for (const g of gcs) if (g.ts >= t0 && g.ts < t1) { ms += g.dur / 1000; if (g.name === 'MajorGC') major += g.dur / 1000; }
    gcOf.set(ticks[i], { ms, major });
}
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
let excess = 0, explained = 0, slow = 0;
for (let i = 5; i < R.length; i++) {
    const r = R[i], g = gcOf.get(r.tick);
    if (!g) continue;
    const m = med(R.slice(Math.max(5, i - 8), i + 9).map(x => x.total));
    if (r.total > m * 1.35) { slow++; excess += r.total - m; explained += Math.min(g.ms, r.total - m); }
    if (g.ms >= gcMin) console.log(`step ${i} tick ${r.tick} dk ${r.dk} total ${r.total} (median ${m.toFixed(0)}) GC ${g.ms.toFixed(1)} ms (major ${g.major.toFixed(1)})`);
}
console.log(`slow steps ${slow}: excess ${excess.toFixed(0)} ms, of it GC ${explained.toFixed(0)} ms`);
