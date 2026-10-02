// Kernel names for profile line numbers: node .claude/kname.cjs <git-rev-or-""> line...
const fs = require('fs'), cp = require('child_process');
const rev = process.argv[2];
const src = rev ? cp.execSync('git show ' + rev + ':rng/defence3/src/sim/sim_parallel.js', { maxBuffer: 1 << 26 }).toString() : fs.readFileSync(__dirname + '/../src/sim/sim_parallel.js', 'utf8');
const lines = src.split('\n'), defs = [];
lines.forEach((l, i) => { const m = l.match(/^SIM_KERNELS\[(SIM_KERNEL_[A-Z_0-9]+)\]/); if (m) defs.push([i + 1, m[1]]); });
for (const a of process.argv.slice(3)) { const l = +a - 2; const d = defs.find(d => d[0] === l) || defs.filter(d => d[0] <= l).pop(); console.log(a, d ? d[1] + (d[0] === l ? '' : ' (+' + (l - d[0]) + ')') : '?'); }
