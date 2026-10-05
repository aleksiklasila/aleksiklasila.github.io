// Top-level let/const/var names of the game's scripts (not on globalThis in
// a vm context), as a JSON array: for probes that look state up by name
// (typed_mem.js reads __typedMemNames).
//   node .claude/probes/topnames.cjs > names.json
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '../../src');
const files = [];
const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.js')) files.push(p); } };
walk(root);
const names = new Set();
for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = /^(?:let|const|var)\s+(.*)$/.exec(line);
        if (!m) continue;
        // Split at commas outside brackets/strings (good enough for declarations).
        let depth = 0, cur = '', parts = [], q = null;
        for (const ch of m[1]) {
            if (q) { if (ch === q) q = null; cur += ch; continue; }
            if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
            if ('([{'.includes(ch)) depth++;
            else if (')]}'.includes(ch)) depth--;
            if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
            if (ch === ';' && depth === 0) break;
            cur += ch;
        }
        parts.push(cur);
        for (const p of parts) { const n = /^\s*([A-Za-z_$][\w$]*)/.exec(p); if (n) names.add(n[1]); }
    }
}
process.stdout.write(JSON.stringify([...names]));
