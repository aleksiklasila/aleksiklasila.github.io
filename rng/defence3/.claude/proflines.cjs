// Line-level self time of named functions in a .cpuprofile (positionTicks).
//   node .claude/proflines.cjs file.cpuprofile fnA,fnB [top=30]
const p = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const names = new Set(process.argv[3].split(',')), top = +process.argv[4] || 30;
const lines = new Map();
const interval = (p.endTime - p.startTime) / Math.max(1, p.samples.length) / 1000;
for (const n of p.nodes) {
    if (!names.has(n.callFrame.functionName)) continue;
    for (const t of n.positionTicks || []) { const k = n.callFrame.functionName + ':' + t.line; lines.set(k, (lines.get(k) || 0) + t.ticks); }
}
for (const [k, v] of [...lines].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log((v * interval).toFixed(0).padStart(7) + ' ms', k);
