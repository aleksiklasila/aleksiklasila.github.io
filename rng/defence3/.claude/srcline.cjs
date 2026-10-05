// Maps a line of the net harness's concatenated game source (profile frames
// with an empty url) back to file:line, and prints that line.
//   node .claude/srcline.cjs 53861 [52681 ...]
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = Array.from(html.matchAll(/<script src="\.\/(src\/[^"?]+)(?:\?[^" ]*)?"/g), m => m[1]).filter(f => !f.endsWith('bootstrap.js'));
// The harness joins the files with '\n;\n' (SOURCE in tests/net-harness.cjs)
// and evaluates the result; profile line numbers are 0-based.
const starts = [];
let line = 0;
for (const f of files) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const n = text.split('\n').length;
    starts.push([line, f, text.split(/\r?\n/)]);
    line += n - 1 + 2;
}
for (const arg of process.argv.slice(2)) {
    const L = Number(arg);
    let hit = null;
    for (const s of starts) if (s[0] <= L) hit = s;
    if (!hit) { console.log(arg, '?'); continue; }
    const local = L - hit[0];
    console.log(arg, '->', hit[1] + ':' + (local + 1), '|', (hit[2][local] || '').trim().slice(0, 160));
}
