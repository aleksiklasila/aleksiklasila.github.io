'use strict';
// Self time by function over helper CPU profiles (prefix.helperN.cpuprofile,
// a --features=prof --keep-names build), ms a step, optionally only under a
// kernel (a function name on the stack).
// Usage: node tests/profile-self.cjs <prefix> [steps] [under] [top]
const fs = require('node:fs');
const prefix = process.argv[2], steps = Number(process.argv[3]) || 1, under = process.argv[4] || '', top = Number(process.argv[5]) || 30;
const by = {}; let tot = 0;
for (let i = 0; ; i++) {
    const file = prefix + '.helper' + i + '.cpuprofile';
    if (!fs.existsSync(file)) break;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')), nodes = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const inU = new Map();
    const isUnder = id => { if (!under) return true; if (inU.has(id)) return inU.get(id); let r = false; for (let q = id; q !== undefined; q = parent.get(q)) if (nodes.get(q).callFrame.functionName === under) { r = true; break; } inU.set(id, r); return r; };
    for (let k = 0; k < p.samples.length; k++) {
        const id = p.samples[k]; if (!isUnder(id)) continue;
        const name = nodes.get(id).callFrame.functionName || '(anonymous)';
        if (name === '(idle)') continue;
        by[name] = (by[name] || 0) + (p.timeDeltas[k] || 0); tot += p.timeDeltas[k] || 0;
    }
}
const ms = v => Math.round(v / 1000 / steps * 10) / 10;
console.log('total', ms(tot), 'ms a step', under ? 'under ' + under : '');
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(String(ms(v)).padStart(8), (100 * v / tot).toFixed(1).padStart(5) + '%', k);
