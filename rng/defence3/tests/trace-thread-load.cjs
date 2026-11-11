'use strict';
// What the other threads do while a simulation step runs: from a Chrome trace
// of a rendered run (scene_tps_probe.cjs with TRACE=..., TRACE_CATS including
// devtools.timeline and blink.user_timing, QUERY=simtrace=1), the busy time
// of every traced thread inside each step's window (between the worker's
// 'simstep <tick>' marks), for the slow steps against their neighbours.
// Busy time: the union of that thread's top-level complete events. Helpers
// that run only wasm show little here (no trace events inside kernels); the
// page, presentation worker, GPU and compositor threads are what it sees.
//   node tests/trace-thread-load.cjs <trace.json> <probe-output.txt> [factor=1.4]
const fs = require('node:fs');
const [traceFile, outFile, factorArg] = process.argv.slice(2);
const factor = Number(factorArg) || 1.4;
const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
const ev = Array.isArray(trace) ? trace : trace.traceEvents;
const rows = [];
for (const l of fs.readFileSync(outFile, 'utf8').split(/\r?\n/)) if (l.startsWith('SIMTRACE ')) rows.push(...JSON.parse(l.slice(9)));
const byTick = new Map(); for (const r of rows) if (!byTick.has(r.tick)) byTick.set(r.tick, r);
const marks = ev.filter(e => typeof e.name === 'string' && e.name.startsWith('simstep '));
if (!marks.length) throw new Error('no simstep marks');
const wtid = marks[0].tid, wpid = marks[0].pid;
const at = new Map(); for (const m of marks) if (m.tid === wtid && m.pid === wpid) at.set(Number(m.name.slice(8)), m.ts);
const names = new Map();
for (const e of ev) if (e.ph === 'M' && e.name === 'thread_name') names.set(e.pid + ':' + e.tid, e.args.name);
const pnames = new Map();
for (const e of ev) if (e.ph === 'M' && e.name === 'process_name') pnames.set(e.pid, e.args.name);
// Top-level complete events per thread, as merged busy intervals.
const per = new Map();
for (const e of ev) {
    if (e.ph !== 'X' || !(e.dur > 0)) continue;
    const k = e.pid + ':' + e.tid;
    let L = per.get(k); if (!L) per.set(k, L = []);
    L.push([e.ts, e.ts + e.dur]);
}
const busy = new Map();
for (const [k, L] of per) {
    L.sort((a, b) => a[0] - b[0]);
    const M = [];
    for (const [s, t] of L) { const last = M[M.length - 1]; if (last && s <= last[1]) last[1] = Math.max(last[1], t); else M.push([s, t]); }
    busy.set(k, M);
}
const busyIn = (k, t0, t1) => { let ms = 0; for (const [s, t] of busy.get(k)) { if (t <= t0) continue; if (s >= t1) break; ms += (Math.min(t, t1) - Math.max(s, t0)) / 1000; } return ms; };
const ticks = [...at.keys()].sort((a, b) => a - b);
const win = tk => { const i = ticks.indexOf(tk); return i >= 0 && i + 1 < ticks.length ? [at.get(tk), at.get(ticks[i + 1])] : null; };
const label = k => { const [p] = k.split(':'); return (pnames.get(Number(p)) || p) + '/' + (names.get(k) || k); };
// Threads that are busy at all during the run, the worker's own excluded.
const threads = [...busy.keys()].filter(k => k !== wpid + ':' + wtid);
const steps = ticks.filter(t => byTick.has(t) && win(t));
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const medByDk = new Map();
for (const t of steps) { const r = byTick.get(t); (medByDk.get(r.dk) || medByDk.set(r.dk, []).get(r.dk)).push(r.total); }
for (const [dk, a] of medByDk) medByDk.set(dk, median(a));
// Per thread: share of the step window busy, slow steps against all steps.
const share = (k, t) => { const [t0, t1] = win(t); return busyIn(k, t0, t1) / ((t1 - t0) / 1000); };
const slow = steps.filter(t => t > 40 && byTick.get(t).total > factor * medByDk.get(byTick.get(t).dk));
const normal = steps.filter(t => t > 40 && !slow.includes(t));
console.log('steps', steps.length, 'slow', slow.length, 'factor', factor);
const rowsOut = threads.map(k => {
    const a = normal.map(t => share(k, t)), b = slow.map(t => share(k, t));
    const avg = x => x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0;
    return { k: label(k), normal: avg(a), slow: avg(b) };
}).filter(r => r.normal > 0.01 || r.slow > 0.01).sort((x, y) => (y.slow - y.normal) - (x.slow - x.normal));
console.log('thread busy share of the step window: normal steps -> slow steps');
for (const r of rowsOut.slice(0, 25)) console.log('  ' + (r.normal * 100).toFixed(1).padStart(6) + '% -> ' + (r.slow * 100).toFixed(1).padStart(6) + '%  ' + r.k);
// The slow steps one by one: the threads that grew most against the step before.
for (const t of slow) {
    const i = ticks.indexOf(t), p = ticks[i - 1];
    if (!win(p)) continue;
    const grew = threads.map(k => [label(k), share(k, t) - share(k, p)]).filter(x => Math.abs(x[1]) > 0.05).sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log('step', t, 'dk', byTick.get(t).dk, 'total', Math.round(byTick.get(t).total), 'prev', Math.round(byTick.get(p).total), grew.map(([n, d]) => n + ' ' + (d > 0 ? '+' : '') + (d * 100).toFixed(0) + '%').join(', '));
}
