// Self and total time per function of one peer's ticks in a tickbench
// profile (PROFILE_RANGE): the samples under that peer's runOneTick (its
// script id: host = the peer with less time (its kernels on helpers),
// guest = the other).
//   node .claude/profpeer2.cjs file.cpuprofile [host|guest] [selfN] [totalN]
const p = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const which = process.argv[3] || 'host', selfN = +process.argv[4] || 40, totalN = +process.argv[5] || 30;
const byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of p.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
const self = new Map();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0));
const sid = new Map(), top = id => { if (sid.has(id)) return sid.get(id); let r = null; for (let x = id; x !== undefined; x = parent.get(x)) { const n = byId.get(x); if (n.callFrame.functionName === 'runOneTick' && n.callFrame.url === '') r = n.callFrame.scriptId; } sid.set(id, r); return r; };
const ids = [...new Set([...self.keys()].map(top))].filter(x => x !== null).map(Number).sort((a, b) => a - b);
const per = new Map(); for (const [id, t] of self) { const s = top(id); if (s !== null) per.set(String(s), (per.get(String(s)) || 0) + t); }
const order = [...per].sort((a, b) => a[1] - b[1]).map(e => e[0]), want = which === 'host' ? order[0] : order[order.length - 1];
const key = n => n.callFrame.functionName + ' :' + n.callFrame.lineNumber;
const fs = new Map(), ft = new Map(); let total = 0;
for (const [id, t] of self) {
    if (String(top(id)) !== want) continue;
    total += t;
    const n = byId.get(id); fs.set(key(n), (fs.get(key(n)) || 0) + t);
    const seen = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) { const k = key(byId.get(x)); if (seen.has(k)) continue; seen.add(k); ft.set(k, (ft.get(k) || 0) + t); }
}
console.log(which, 'script', want, 'total', (total / 1000).toFixed(0), 'ms');
console.log('SELF'); for (const [k, v] of [...fs].sort((a, b) => b[1] - a[1]).slice(0, selfN)) console.log(String(Math.round(v / 1000)).padStart(7), 'ms', k);
console.log('TOTAL'); for (const [k, v] of [...ft].sort((a, b) => b[1] - a[1]).slice(0, totalN)) console.log(String(Math.round(v / 1000)).padStart(7), 'ms', k);
