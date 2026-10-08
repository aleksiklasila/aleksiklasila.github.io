// Total time of each child (and grandchild with depth 2) of a function in a
// .cpuprofile:  node .claude/profkids.cjs file.cpuprofile <functionName> [depth=1] [top=30]
const p = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const name = process.argv[3], depth = +process.argv[4] || 1, top = +process.argv[5] || 30;
const byId = new Map(p.nodes.map(n => [n.id, n]));
const self = new Map();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0));
const tot = new Map();
const total = id => { if (tot.has(id)) return tot.get(id); const n = byId.get(id); let t = self.get(id) || 0; for (const c of n.children || []) t += total(c); tot.set(id, t); return t; };
const agg = new Map();
let rootT = 0;
const walk = (id, d, path) => {
    const n = byId.get(id);
    for (const c of n.children || []) {
        const cn = byId.get(c), k = path + cn.callFrame.functionName + ':' + cn.callFrame.lineNumber;
        agg.set(k, (agg.get(k) || 0) + total(c));
        if (d < depth) walk(c, d + 1, k + ' > ');
    }
};
for (const n of p.nodes) if (n.callFrame.functionName === name) { rootT += total(n.id); walk(n.id, 1, ''); }
console.log(name, (rootT / 1000).toFixed(0), 'ms');
for (const [k, v] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log((v / 1000).toFixed(0).padStart(8), (100 * v / rootT).toFixed(1).padStart(5) + '%', k);
