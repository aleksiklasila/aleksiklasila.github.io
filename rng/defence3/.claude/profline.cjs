// Line-level hot spots from a --cpu-prof profile of the net harness: maps the
// concatenated SOURCE lines back to file:line and prints the code.
//   node .claude/profline.cjs <profile.cpuprofile> [fnName ...]
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = Array.from(html.matchAll(/<script src="\.\/(src\/[^"?]+)(?:\?[^" ]*)?"/g), m => m[1]).filter(f => !f.endsWith('bootstrap.js'));
const map = []; // concatenated line (1-based) -> [file, line]
let line = 1;
for (const f of files) {
    const n = fs.readFileSync(path.join(root, f), 'utf8').split('\n').length;
    for (let i = 0; i < n; i++) map[line + i] = [f, i + 1];
    line += n + 1; // '\n;\n' adds one line
}
const text = {}; const getLine = (f, l) => (text[f] ||= fs.readFileSync(path.join(root, f), 'utf8').split('\n'))[l - 1];
const p = JSON.parse(fs.readFileSync(process.argv[2]));
const want = new Set(process.argv.slice(3));
const hits = new Map(); let total = 0;
for (const n of p.nodes) {
    if (!n.positionTicks || (want.size && !want.has(n.callFrame.functionName))) continue;
    for (const t of n.positionTicks) { const k = n.callFrame.functionName + '@' + t.line; hits.set(k, (hits.get(k) || 0) + t.ticks); total += t.ticks; }
}
for (const [k, v] of [...hits].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    const [fn, l] = k.split('@'); const m = map[+l] || ['?', 0];
    console.log(String(v).padStart(6), fn.padEnd(28), `${m[0].split('/').pop()}:${m[1]}`.padEnd(22), (getLine(m[0], m[1]) || '').trim().slice(0, 110));
}
