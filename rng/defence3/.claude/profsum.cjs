// Self and total time per function of a .cpuprofile:
//   node .claude/profsum.cjs file.cpuprofile [selfN] [totalN] [subtreeFunctionName]
// (with a function name: only samples under that function count).
const p = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const byId = new Map(p.nodes.map(n => [n.id, n]));
const self = new Map(), dt = p.timeDeltas; const cnt = new Map();
for (let i = 0; i < p.samples.length; i++) cnt.set(p.samples[i], (cnt.get(p.samples[i]) || 0) + (dt[i] || 0));
const parent = new Map(); for (const n of p.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
const key = n => n.callFrame.functionName + ' ' + (n.callFrame.url || '').split('/').pop() + ':' + n.callFrame.lineNumber;
const tot = new Map();
const root = process.argv[5];
const under = id => { if (!root) return true; for (let x = id; x !== undefined; x = parent.get(x)) if (byId.get(x).callFrame.functionName === root) return true; return false; };
for (const [id, t] of cnt) { if (!under(id)) continue; const n = byId.get(id); self.set(key(n), (self.get(key(n)) || 0) + t); const seen = new Set(); let x = id; while (x !== undefined) { const k = key(byId.get(x)); if (!seen.has(k)) { seen.add(k); tot.set(k, (tot.get(k) || 0) + t); } x = parent.get(x); } }
const all = [...cnt].filter(([id]) => under(id)).reduce((a, [, b]) => a + b, 0);
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => (v / 1000).toFixed(0).padStart(8) + 'ms ' + (100 * v / all).toFixed(1).padStart(5) + '% ' + k).join('\n');
console.log('total', (all / 1000).toFixed(0), 'ms\nSELF\n' + top(self, +process.argv[3] || 30) + '\nTOTAL\n' + top(tot, +process.argv[4] || 40));
