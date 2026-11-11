'use strict';
// What recurs in slow steps, over one or more rendered runs (scene_tps_probe
// output with QUERY=simtrace=1): each step over `factor` x the median step of
// its dk (after tick 40) against the mean of its previous and next steps; the
// growth summed per phase over all slow steps, with how many slow steps each
// phase grew in by more than 2 ms. Phases nest (simMoveRun holds kp:89 and
// kp:8; workerSearchTierStep holds _ws*): read a parent with its children.
// cpu:<k> is helper CPU summed over jobs, n:<k> the job count, kp:<k> the
// kernel's wall time on the simulation thread.
//   node tests/slow-step-attribution.cjs out1.txt [out2.txt ...] [--factor=1.3]
const fs = require('node:fs');
const args = process.argv.slice(2);
const factor = Number((args.find(a => a.startsWith('--factor=')) || '--factor=1.3').slice(9));
const files = args.filter(a => !a.startsWith('--'));
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const grew = new Map(), count = new Map();
let slowSteps = 0, steps = 0, excessSum = 0;
const perRun = [];
for (const f of files) {
    let rows = [];
    for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) if (l.startsWith('SIMTRACE ')) rows.push(...JSON.parse(l.slice(9)));
    const seen = new Set();
    rows = rows.filter(r => !seen.has(r.tick) && seen.add(r.tick)).sort((a, b) => a.tick - b.tick);
    const play = rows.filter(r => r.tick > 40);
    const med = new Map();
    for (const r of play) (med.get(r.dk) || med.set(r.dk, []).get(r.dk)).push(r.total);
    for (const [dk, a] of med) med.set(dk, median(a));
    let runSlow = 0, runExcess = 0;
    for (let i = 1; i + 1 < rows.length; i++) {
        const r = rows[i];
        if (r.tick <= 40) continue;
        steps++;
        if (!(r.total > factor * med.get(r.dk))) continue;
        const p = rows[i - 1], n = rows[i + 1];
        slowSteps++; runSlow++;
        const base = (p.total + n.total) / 2, ex = r.total - base;
        excessSum += ex; runExcess += ex;
        const keys = new Set([...Object.keys(r.ph), ...Object.keys(p.ph), ...Object.keys(n.ph)]);
        for (const k of keys) {
            const v = x => typeof x.ph[k] === 'number' ? x.ph[k] : 0;
            if (/^(helpers|bindNames)/.test(k)) continue;
            const d = v(r) - (v(p) + v(n)) / 2;
            grew.set(k, (grew.get(k) || 0) + d);
            if (d > 2) count.set(k, (count.get(k) || 0) + 1);
        }
        for (const k of ['gap', 'late']) { const d = r[k] - (p[k] + n[k]) / 2; grew.set('(' + k + ')', (grew.get('(' + k + ')') || 0) + d); if (d > 2) count.set('(' + k + ')', (count.get('(' + k + ')') || 0) + 1); }
    }
    perRun.push(f.replace(/.*[\\/]/, '') + ': ' + runSlow + ' slow, excess ' + Math.round(runExcess) + ' ms');
}
console.log('runs:', perRun.join('; '));
console.log('steps', steps, 'slow', slowSteps, 'factor', factor, 'excess over neighbours', Math.round(excessSum), 'ms');
console.log('growth over all slow steps (ms), and in how many slow steps it grew > 2 ms:');
for (const [k, v] of [...grew].sort((a, b) => b[1] - a[1]).slice(0, 45)) console.log('  ' + v.toFixed(0).padStart(7) + '  ' + String(count.get(k) || 0).padStart(4) + '  ' + k);
