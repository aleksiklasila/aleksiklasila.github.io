// Self/total per function under gameTick, split by peer (the vm context's
// scriptId of the gameTick frame):
//   node .claude/profpeer.cjs file.cpuprofile [selfN] [totalN] [root=gameTick]
const p = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const parent = new Map(); for (const n of p.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
const root = process.argv[5] || 'gameTick';
const cnt = new Map(), dt = p.timeDeltas;
for (let i = 0; i < p.samples.length; i++) cnt.set(p.samples[i], (cnt.get(p.samples[i]) || 0) + (dt[i] || 0));
const key = n => n.callFrame.functionName + ':' + n.callFrame.lineNumber;
const peers = new Map();
for (const [id, t] of cnt) {
    let r = null;
    for (let x = id; x !== undefined; x = parent.get(x)) { const n = byId.get(x); if (n.callFrame.functionName === root) { r = n.callFrame.scriptId; break; } }
    if (r === null) continue;
    let P = peers.get(r); if (!P) peers.set(r, P = { all: 0, self: new Map(), tot: new Map() });
    P.all += t;
    const n = byId.get(id); P.self.set(key(n), (P.self.get(key(n)) || 0) + t);
    const seen = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) { const k = key(byId.get(x)); if (seen.has(k)) continue; seen.add(k); P.tot.set(k, (P.tot.get(k) || 0) + t); if (byId.get(x).callFrame.functionName === root) break; }
}
const top = (m, n, all) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => (v / 1000).toFixed(0).padStart(7) + 'ms ' + (100 * v / all).toFixed(1).padStart(5) + '% ' + k).join('\n');
for (const [sid, P] of peers) console.log('=== script', sid, 'total', (P.all / 1000).toFixed(0), 'ms\nSELF\n' + top(P.self, +process.argv[3] || 30, P.all) + '\nTOTAL\n' + top(P.tot, +process.argv[4] || 50, P.all));
