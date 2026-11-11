'use strict';
// Side by side, rendered runs (scene_tps_probe output with QUERY=simtrace=1),
// from tick 40 on: ms per base tick (step total / dk), step p50 / p95 / p99 /
// max, slow steps (over 1.3x their dk's median) and their excess over their
// neighbours, the simulation thread's background waits per step (all lanes,
// lane 4), its own background chunks per step (bgc), steps a second and fps
// (the probe's samples).
//   node tests/compare-runs.cjs run1.txt run2.txt ...
const fs = require('node:fs');
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const rowsOut = [];
for (const f of process.argv.slice(2)) {
    const text = fs.readFileSync(f, 'utf8');
    let rows = [];
    const samples = [];
    for (const l of text.split(/\r?\n/)) {
        if (l.startsWith('SIMTRACE ')) rows.push(...JSON.parse(l.slice(9)));
        else if (l.startsWith('{"at"')) { try { samples.push(JSON.parse(l)); } catch { } }
    }
    const seen = new Set();
    rows = rows.filter(r => !seen.has(r.tick) && seen.add(r.tick)).sort((a, b) => a.tick - b.tick);
    const play = rows.filter(r => r.tick > 40);
    if (!play.length) { rowsOut.push([f, 'no steps']); continue; }
    const med = new Map();
    for (const r of play) (med.get(r.dk) || med.set(r.dk, []).get(r.dk)).push(r.total);
    for (const [dk, a] of med) med.set(dk, q(a, 0.5));
    let slow = 0, excess = 0;
    for (let i = 1; i + 1 < rows.length; i++) {
        const r = rows[i]; if (r.tick <= 40) continue;
        if (r.total > 1.3 * med.get(r.dk)) { slow++; excess += r.total - (rows[i - 1].total + rows[i + 1].total) / 2; }
    }
    const sum = (r, re) => Object.keys(r.ph).filter(k => re.test(k)).reduce((s, k) => s + (typeof r.ph[k] === 'number' ? r.ph[k] : 0), 0);
    const perTick = play.reduce((s, r) => s + r.total / r.dk, 0) / play.length;
    const tot = play.map(r => r.total);
    const wAll = play.reduce((s, r) => s + sum(r, /^w:/), 0) / play.length;
    const w4 = play.reduce((s, r) => s + sum(r, /^w:4$/), 0) / play.length;
    const bgc = play.reduce((s, r) => s + sum(r, /^bgc:/), 0) / play.length;
    const kp89 = play.reduce((s, r) => s + sum(r, /^kp:89$/), 0) / play.length;
    const sps = samples.length ? samples.reduce((s, x) => s + (x.ticksPerSec || 0), 0) / samples.length : NaN;
    const fps = samples.length ? samples.reduce((s, x) => s + (x.fps || 0), 0) / samples.length : NaN;
    const dk = play.reduce((s, r) => s + r.dk, 0) / play.length;
    rowsOut.push([f.replace(/.*[\\/]/, '').replace(/\.txt$/, ''), perTick.toFixed(1), dk.toFixed(2), q(tot, .5).toFixed(0), q(tot, .95).toFixed(0), q(tot, .99).toFixed(0), Math.max(...tot).toFixed(0),
        slow, excess.toFixed(0), wAll.toFixed(1), w4.toFixed(1), bgc.toFixed(1), kp89.toFixed(1), sps.toFixed(1), fps.toFixed(0)]);
}
const head = ['run', 'ms/tick', 'dk', 'p50', 'p95', 'p99', 'max', 'slow', 'excess', 'wait/st', 'w4/st', 'bgc/st', 'kp89', 'steps/s', 'fps'];
const w = head.map((h, i) => Math.max(h.length, ...rowsOut.map(r => String(r[i] ?? '').length)));
console.log(head.map((h, i) => h.padStart(w[i])).join('  '));
for (const r of rowsOut) console.log(r.map((v, i) => String(v ?? '').padStart(w[i])).join('  '));
