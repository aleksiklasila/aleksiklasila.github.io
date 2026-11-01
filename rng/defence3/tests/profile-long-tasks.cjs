'use strict';
// The long tasks of a page CPU profile (.cpuprofile): runs of samples with
// no idle gap of more than GAP ms, at least MIN ms long; for each, its time,
// its top functions by inclusive and self time, so a spike is named by what
// ran in it, not by a whole run's totals.
//   node tests/profile-long-tasks.cjs <file.cpuprofile> [min ms=50] [top=8]
const fs = require('node:fs');
const file = process.argv[2], MIN = Number(process.argv[3]) || 50, TOP = Number(process.argv[4]) || 8, GAP = 4;
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const name = n => `${n.callFrame.functionName || '(anon)'} ${(n.callFrame.url || '').split('/').pop().split('?')[0]}:${n.callFrame.lineNumber + 1}`;
const idle = n => /^\((idle|program|garbage collector)\)$/.test(n.callFrame.functionName) && n.callFrame.functionName !== '(garbage collector)';
let t = p.startTime;
const samples = p.samples.map((id, i) => { t += p.timeDeltas[i]; return { id, t: t / 1000 }; });
const runs = [];
let cur = null;
for (let i = 0; i < samples.length; i++) {
    const s = samples[i], n = byId.get(s.id);
    if (idle(n)) { if (cur && s.t - cur.last > GAP) { runs.push(cur); cur = null; } continue; }
    if (!cur) cur = { start: s.t, last: s.t, ids: [] };
    cur.last = s.t; cur.ids.push({ id: s.id, dt: i + 1 < samples.length ? samples[i + 1].t - s.t : 0 });
}
if (cur) runs.push(cur);
const long = runs.filter(r => r.last - r.start >= MIN).sort((a, b) => (b.last - b.start) - (a.last - a.start));
console.log(`${long.length} busy runs >= ${MIN} ms (of ${runs.length}), profile ${((samples.at(-1).t - samples[0].t) / 1000).toFixed(1)} s`);
for (const r of long.slice(0, Number(process.env.RUNS) || 12)) {
    const incl = new Map(), self = new Map();
    for (const { id, dt } of r.ids) {
        const n = byId.get(id);
        self.set(name(n), (self.get(name(n)) || 0) + dt);
        const seen = new Set();
        for (let x = id; x !== undefined; x = parent.get(x)) { const k = name(byId.get(x)); if (seen.has(k)) continue; seen.add(k); incl.set(k, (incl.get(k) || 0) + dt); }
    }
    const fmt = m => [...m].filter(([k]) => !/^\(root\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => `${v.toFixed(0)} ${k}`).join(' | ');
    console.log(`\n@${((r.start - samples[0].t) / 1000).toFixed(2)}s ${(r.last - r.start).toFixed(0)} ms\n  incl: ${fmt(incl)}\n  self: ${fmt(self)}`);
}
