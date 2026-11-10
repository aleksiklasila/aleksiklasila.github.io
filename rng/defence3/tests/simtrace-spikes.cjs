'use strict';
// The slow steps of a rendered Edge run: reads the SIMTRACE line that
// tests/perf-fuzz/simtrace-dump.js makes (DUMP= of .claude/scene_tps_probe.cjs,
// QUERY=simtrace=1, the probe's stdout saved to a file) and prints the step
// totals (p50/p95/p99/max, steps a second of base ticks), then each step
// slower than FACTOR (default 1.35) x the median of its 17-step window: its
// previous and next steps and the phases that grew against their mean.
//   node tests/simtrace-spikes.cjs <probe-output.txt> [skipSteps=5] [factor]
const fs = require('node:fs');
const text = fs.readFileSync(process.argv[2], 'utf8').replace(/^﻿/, '');
const line = text.split(/\r?\n/).find(l => l.startsWith('SIMTRACE '));
if (!line) throw new Error('no SIMTRACE line (DUMP=tests/perf-fuzz/simtrace-dump.js, QUERY=simtrace=1)');
const all = JSON.parse(line.slice(9)), skip = Number(process.argv[3] ?? 5), factor = Number(process.argv[4]) || 1.35;
const R = all.slice(skip);
// (dk: the step's base ticks, as the worker's trace row has it; `tick` counts steps.)
for (const r of R) if (!(r.dk > 0)) r.dk = null;
const tot = R.map(r => r.total).sort((a, b) => a - b), q = p => tot[Math.min(tot.length - 1, Math.ceil(tot.length * p) - 1)];
const mean = tot.reduce((s, v) => s + v, 0) / tot.length;
const dks = R.map(r => r.dk).filter(d => d > 0);
console.log(JSON.stringify({ steps: R.length, ticks: [R[0].tick, R.at(-1).tick], dk: dks.length ? { min: Math.min(...dks), max: Math.max(...dks), mean: +(dks.reduce((s, v) => s + v, 0) / dks.length).toFixed(2) } : 'not traced',
    mean: +mean.toFixed(1), p50: q(.5), p95: q(.95), p99: q(.99), max: q(1), over1_5mean: tot.filter(v => v > mean * 1.5).length }));
// Chunk stalls: a step whose longest single chunk of a kernel (chunkMax:<id>,
// any thread) took over 10 ms; and the probe's own samples (fps, steps/s).
const stalls = R.map(r => Math.max(0, ...Object.entries(r.ph).filter(([k, v]) => k.startsWith('chunkMax:') && typeof v === 'number').map(([, v]) => v)));
const samples = text.split(/\r?\n/).filter(l => l.startsWith('{"at"')).map(l => JSON.parse(l)).slice(2);
const sm = k => samples.length ? +(samples.reduce((s, r) => s + (r[k] || 0), 0) / samples.length).toFixed(1) : null;
console.log(JSON.stringify({ chunkStall10: stalls.filter(v => v > 10).length, chunkStall20: stalls.filter(v => v > 20).length, longestChunk: +Math.max(...stalls).toFixed(1),
    fps: sm('fps'), fpsMin: samples.length ? Math.min(...samples.map(r => r.fps)) : null, stepsPerSec: sm('ticksPerSec'), helpers: samples[0] && samples[0].helpers }));
// Mean phases (top 20).
const names = new Set(); for (const r of R) for (const k of Object.keys(r.ph)) if (typeof r.ph[k] === 'number') names.add(k);
const avg = k => R.reduce((s, r) => s + (r.ph[k] || 0), 0) / R.length;
console.log('mean phases', [...names].map(k => [k, avg(k)]).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => k + ' ' + v.toFixed(1)).join(', '));
const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
let n = 0;
for (let i = 1; i < R.length - 1; i++) {
    const w = R.slice(Math.max(0, i - 8), i + 9).map(r => r.total), m = med(w), r = R[i];
    if (r.total <= m * factor) continue;
    n++;
    const a = R[i - 1], b = R[i + 1], base = k => ((a.ph[k] || 0) + (b.ph[k] || 0)) / 2;
    const keys = new Set([...Object.keys(r.ph), ...Object.keys(a.ph), ...Object.keys(b.ph)].filter(k => typeof (r.ph[k] ?? a.ph[k] ?? b.ph[k]) === 'number'));
    const grew = [...keys].map(k => [k, (r.ph[k] || 0) - base(k)]).sort((x, y) => y[1] - x[1]).slice(0, 10);
    console.log(`step ${i} tick ${r.tick} dk ${r.dk} total ${r.total} (window median ${m.toFixed(0)}; prev ${a.total} next ${b.total}) gap ${r.gap} late ${r.late}`);
    console.log('   grew: ' + grew.map(([k, v]) => k + (v >= 0 ? '+' : '') + v.toFixed(1)).join(' '));
    if (r.ph['slow:89']) console.log('   slow:89 ' + JSON.stringify(r.ph['slow:89']).slice(0, 200));
}
console.log('slow steps', n);
