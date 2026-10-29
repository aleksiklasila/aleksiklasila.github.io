// Self time by function under one phase's calls (a function name on the
// stack: processActions, runQueuedOrders...), per step, from a chaos bench
// run captured with --profile (main thread only).
// node tests/profile-subtree.cjs run.json ROOT [--steps=30,31] [--top=25]
'use strict';
const fs = require('node:fs'), path = require('node:path');
const file = path.resolve(process.argv[2]), root = process.argv[3];
const opt = k => process.argv.find(a => a.startsWith('--' + k + '='))?.split('=')[1];
const run = JSON.parse(fs.readFileSync(file)), profile = JSON.parse(fs.readFileSync(file + '.cpuprofile'));
const top = Number(opt('top') || 25);
const steps = opt('steps') ? opt('steps').split(',').map(Number) : run.rows.filter(r => r.step >= (run.profileOrigins?.startStep || 0)).map(r => r.step);
const nodes = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of profile.nodes) for (const id of n.children || []) parent.set(id, n.id);
const label = f => (f.functionName || '(anonymous)') + (f.url ? ' ' + path.basename(f.url) + ':' + (f.lineNumber + 1) : '');
// (The node's nearest ancestor named root, memoized: in its subtree or not.)
const under = new Map();
const inRoot = id => {
    if (under.has(id)) return under.get(id);
    const n = nodes.get(id);
    const v = !n ? false : n.callFrame.functionName === root ? true : parent.has(id) ? inRoot(parent.get(id)) : false;
    under.set(id, v); return v;
};
const origin = run.profileOrigins.main;
for (const step of steps) {
    const r = run.rows.find(x => x.step === step);
    if (!r) continue;
    const a = r.at - origin, b = a + (r.wallMs ?? r.ms);
    const self = new Map();
    let t = 0, total = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const next = t + (profile.timeDeltas[i] || 0) / 1000;
        const ms = Math.max(0, Math.min(next, b) - Math.max(t, a)); t = next;
        if (!ms) { if (t > b) break; continue; }
        const id = profile.samples[i];
        if (!inRoot(id)) continue;
        const k = label(nodes.get(id).callFrame);
        self.set(k, (self.get(k) || 0) + ms); total += ms;
    }
    console.log(`step ${step} wall ${(r.wallMs ?? r.ms).toFixed(0)} ms, ${root} sampled ${total.toFixed(1)} ms` + (r.mass ? ' ' + JSON.stringify(r.mass) : ''));
    for (const [k, ms] of [...self].sort((x, y) => y[1] - x[1]).slice(0, top)) console.log('  ' + ms.toFixed(1).padStart(7) + '  ' + k);
}
