'use strict';
// Self time by function in CPU profiles, counting only samples whose stack
// passes through a function matching ROOT (a regex), and the inclusive time
// of each function under it.
//   node tests/profile-under.cjs ROOT file.cpuprofile [...]   (TOP=40)
const fs = require('node:fs');
const root = new RegExp(process.argv[2]);
const files = process.argv.slice(3);
const top = Number(process.env.TOP) || 40;
const self = new Map(), incl = new Map();
let under = 0, all = 0, ms = 0;
for (const f of files) {
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    const byId = new Map(p.nodes.map(n => [n.id, n]));
    const parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const name = n => n.callFrame.functionName || ('(' + (n.callFrame.url || 'anon').split('/').pop() + ')');
    const memo = new Map();
    const chain = id => {
        if (memo.has(id)) return memo.get(id);
        const names = []; let x = id, hit = false;
        while (x !== undefined) { const n = byId.get(x); const nm = name(n); names.push(nm); if (root.test(nm)) { hit = true; break; } x = parent.get(x); }
        const r = hit ? names : null; memo.set(id, r); return r;
    };
    const dt = p.timeDeltas || [];
    for (let i = 0; i < p.samples.length; i++) {
        const d = (dt[i] || 0) / 1000; const n = byId.get(p.samples[i]); const nm = name(n);
        if (nm === '(idle)' || nm === '(program)' || nm === '(garbage collector)') { if (nm !== '(idle)') all += d; continue; }
        all += d;
        const c = chain(p.samples[i]); if (!c) continue;
        under += d; self.set(c[0], (self.get(c[0]) || 0) + d);
        for (const x of new Set(c)) incl.set(x, (incl.get(x) || 0) + d);
    }
    ms += (p.endTime - p.startTime) / 1000;
}
console.log('profiles', files.length, 'wall ms each ~', Math.round(ms / files.length), 'busy ms', Math.round(all), 'under', root, Math.round(under), 'ms');
const pr = (m, label) => { console.log(label); for (const [k, v] of [...m].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log('  ' + (v / under * 100).toFixed(1).padStart(5) + '%  ' + Math.round(v).toString().padStart(6) + ' ms  ' + k.slice(0, 110)); };
pr(self, 'self:');
pr(incl, 'inclusive:');
