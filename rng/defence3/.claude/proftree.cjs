// Inclusive time of the functions below a named root in a .cpuprofile.
//   node .claude/proftree.cjs file.cpuprofile rootFn [depth=3] [min_ms=0.2]
const p = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const root = process.argv[3], maxDepth = +process.argv[4] || 3, minMs = +(process.argv[5] || 0.2);
const byId = new Map(p.nodes.map(n => [n.id, n]));
const self = new Map();
const dt = p.timeDeltas;
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (dt[i + 1] || 0) / 1000);
const incl = new Map();
function tot(n) {
    if (incl.has(n.id)) return incl.get(n.id);
    let t = self.get(n.id) || 0;
    for (const c of n.children || []) t += tot(byId.get(c));
    incl.set(n.id, t);
    return t;
}
// Merge all root occurrences by call path of function names.
const agg = new Map();
function walk(n, path, d) {
    const k = path + '/' + n.callFrame.functionName + ':' + n.callFrame.lineNumber;
    agg.set(k, (agg.get(k) || 0) + tot(n));
    if (d >= maxDepth) return;
    for (const c of n.children || []) walk(byId.get(c), k, d + 1);
}
for (const n of p.nodes) if (n.callFrame.functionName === root) {
    // skip nested occurrences
    walk(n, '', 0);
}
const ticks = +(process.env.TICKS || 1);
for (const [k, v] of [...agg].sort((a, b) => a[0] < b[0] ? -1 : 1)) if (v / ticks >= minMs) {
    const parts = k.split('/');
    console.log('  '.repeat(parts.length - 2) + (v / ticks).toFixed(2).padStart(8) + ' ms ' + parts[parts.length - 1]);
}
