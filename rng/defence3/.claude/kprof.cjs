// Line-level profile of one dumped kernel (kbench under --cpu-prof): the
// hottest lines of src/sim/sim_parallel.js with their share.
//   node .claude/kprof.cjs <dumpdir> <KERNEL_NAME> [reps=20] [top=40]
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const [dir, name] = process.argv.slice(2), reps = process.argv[4] || '20', top = +process.argv[5] || 40;
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kprof-'));
cp.execFileSync(process.execPath, ['--cpu-prof', '--cpu-prof-interval', '50', '--cpu-prof-dir', out, path.join(__dirname, 'kbench.cjs'), dir, name, '1', reps], { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
const file = fs.readdirSync(out).find(f => f.endsWith('.cpuprofile'));
const p = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
const lines = new Map(); let tot = 0;
for (const n of p.nodes) { if (!/sim_parallel/.test(n.callFrame.url)) continue; for (const t of n.positionTicks || []) { lines.set(t.line, (lines.get(t.line) || 0) + t.ticks); tot += t.ticks; } }
const src = fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8').split('\n');
console.log('samples in sim_parallel.js:', tot);
for (const [l, c] of [...lines].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(String(c).padStart(6), (100 * c / tot).toFixed(1).padStart(5) + '%', String(l).padStart(5), src[l - 1].trim().slice(0, 120));
