'use strict';
// Helper CPU by kernel family from helper CPU profiles (a --features=prof
// --keep-names build; tests/occ-sched-probe.cjs PROF=prefix writes
// prefix.helperN.cpuprofile): self time of each function, summed under the
// kernel (the exported mv_* / k_* function nearest the root on its stack),
// then by family; per measured step when STEPS is given.
// Usage: node tests/profile-families.cjs <prefix> [steps]
const fs = require('node:fs');
const prefix = process.argv[2], steps = Number(process.argv[3]) || 1;
const fam = n => /^mv_flow_/.test(n) ? 'steering looks (mv_flow_*)' : n === 'mv_move_occupancy' ? 'mv_move_occupancy (89)' : n === 'mv_move' || n === 'mv_step' ? 'mv_move (8)'
    : /^k_acq/.test(n) ? 'acquisition (k_acq*)' : /^k_ws/.test(n) ? 'worker search (k_ws*)' : /^k_vis/.test(n) ? 'visibility (k_vis*)' : /traffic|^occ_|^k_occ/.test(n) ? 'traffic + occupancy counts' : n;
const byK = {}, byF = {}; let busy = 0, all = 0;
for (let i = 0; ; i++) {
    const file = prefix + '.helper' + i + '.cpuprofile';
    if (!fs.existsSync(file)) break;
    const p = JSON.parse(fs.readFileSync(file, 'utf8')), nodes = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const self = new Map();
    for (let k = 0; k < p.samples.length; k++) self.set(p.samples[k], (self.get(p.samples[k]) || 0) + (p.timeDeltas[k] || 0));
    const kernelOf = new Map();
    const kern = id => {
        if (kernelOf.has(id)) return kernelOf.get(id);
        let best = null;
        for (let q = id; q !== undefined; q = parent.get(q)) { const f = nodes.get(q).callFrame, name = f.functionName; if (/^(mv_|k_|occ_|nav|atlas|pres_)/.test(name) && /wasm/.test(f.url || 'wasm')) best = name; }
        kernelOf.set(id, best); return best;
    };
    for (const [id, us] of self) {
        all += us;
        const name = nodes.get(id).callFrame.functionName;
        if (name === '(idle)' || name === '(program)' && !kern(id)) continue;
        const k = kern(id) || ('js:' + (name || '(anonymous)'));
        if (/^js:(wait|\(garbage|\(program)/.test(k)) continue;
        busy += us; byK[k] = (byK[k] || 0) + us;
    }
}
for (const k in byK) byF[fam(k)] = (byF[fam(k)] || 0) + byK[k];
const ms = v => Math.round(v / 1000 / steps * 10) / 10;
console.log('helper busy ms a step', ms(busy), '(profiled', ms(all), ')');
for (const [k, v] of Object.entries(byF).sort((a, b) => b[1] - a[1]).slice(0, 24)) console.log(String(ms(v)).padStart(8), (100 * v / busy).toFixed(1).padStart(5) + '%', k);
