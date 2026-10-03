// Allocation by function from a sampling heap profile (tickbench
// HEAPPROF_RANGE, collected objects included): self bytes per function
// (top N), and per script id (the harness's peers compile the game each).
//   node .claude/heapsum.cjs file.heapprofile [top=40]
const p = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
if (p.err) { console.log(p.err); process.exit(1); }
const top = +process.argv[3] || 40, self = new Map(), scripts = new Map();
let total = 0;
const walk = n => {
    const key = (n.callFrame.functionName || '(anon)') + ' ' + (n.callFrame.url || '').split('/').pop() + ':' + n.callFrame.lineNumber;
    self.set(key, (self.get(key) || 0) + n.selfSize); total += n.selfSize;
    const sk = n.callFrame.scriptId; scripts.set(sk, (scripts.get(sk) || 0) + n.selfSize);
    for (const c of n.children || []) walk(c);
};
walk(p.head);
console.log('total sampled', (total / 1048576).toFixed(1), 'MB; by script id:', [...scripts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => k + ':' + (v / 1048576).toFixed(1) + 'MB').join(' '));
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log((v / 1048576).toFixed(2).padStart(8), 'MB', k);
