// Self time by function of a Rust kernel replay (rbench.cjs under
// --cpu-prof): wasm functions by name (mark helpers #[inline(never)] to
// see them apart).
//   node .claude/rprof.cjs <dumpdir> <KERNEL_NAME> [reps=10] [top=25]
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const [dir, name] = process.argv.slice(2), reps = process.argv[4] || '10', top = +process.argv[5] || 25;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'rprof-'));
cp.execFileSync(process.execPath, ['--max-old-space-size=8000', '--cpu-prof', '--cpu-prof-interval', '100', '--cpu-prof-dir', out, path.join(__dirname, 'rbench.cjs'), dir, name, '1', reps], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
const file = fs.readdirSync(out).find(f => f.endsWith('.cpuprofile'));
const p = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
const self = new Map(); let tot = 0;
const dt = p.timeDeltas, byId = new Map(p.nodes.map(n => [n.id, n]));
const cnt = new Map();
for (let i = 0; i < p.samples.length; i++) cnt.set(p.samples[i], (cnt.get(p.samples[i]) || 0) + 1);
for (const [id, c] of cnt) { const n = byId.get(id), k = n.callFrame.functionName || '(' + n.callFrame.url.split('/').pop() + ')'; self.set(k, (self.get(k) || 0) + c); tot += c; }
for (const [k, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(String(c).padStart(7), (100 * c / tot).toFixed(1).padStart(5) + '%', k);
