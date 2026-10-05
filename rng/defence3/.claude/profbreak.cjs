// The host's (or guest's) simulation thread in a tickbench profile
// (PROFILE_RANGE), per tick: for each listed phase function its total, and
// under it the functions by total (inclusive) and self time, with file:line
// (the harness's concatenated source mapped back, see srcline.cjs).
//   node .claude/profbreak.cjs file.cpuprofile ticks [host|guest] [phase,phase,...] [topN]
const fs = require('fs'), path = require('path');
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ticks = +process.argv[3] || 1, which = process.argv[4] || 'host';
const phases = (process.argv[5] || '_forEachUnitInTickOrder,simMoveRun,resyncAfterTick,runUnitSeparationPass,unitHitsResolve').split(',');
const topN = +process.argv[6] || 14;
// (Concatenated source lines -> file:line.)
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const files = Array.from(html.matchAll(/<script src="\.\/(src\/[^"?]+)(?:\?[^" ]*)?"/g), m => m[1]).filter(f => !f.endsWith('bootstrap.js'));
const starts = []; let line = 0;
for (const f of files) { const n = fs.readFileSync(path.join(root, f), 'utf8').split('\n').length; starts.push([line, f]); line += n - 1 + 2; }
const where = (url, ln) => {
    if (url) return url.split('/').pop() + ':' + (ln + 1);
    let hit = null; for (const s of starts) if (s[0] <= ln) hit = s;
    return hit ? hit[1].split('/').pop() + ':' + (ln - hit[0] + 1) : '?:' + ln;
};
const byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of p.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
const self = new Map();
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (p.timeDeltas[i] || 0));
const sid = new Map(), top = id => { if (sid.has(id)) return sid.get(id); let r = null; for (let x = id; x !== undefined; x = parent.get(x)) { const n = byId.get(x); if (n.callFrame.functionName === 'runOneTick' && n.callFrame.url === '') r = n.callFrame.scriptId; } sid.set(id, r); return r; };
const per = new Map(); for (const [id, t] of self) { const s = top(id); if (s !== null) per.set(String(s), (per.get(String(s)) || 0) + t); }
const order = [...per].sort((a, b) => a[1] - b[1]).map(e => e[0]), want = which === 'host' ? order[0] : order[order.length - 1];
const name = n => (n.callFrame.functionName || '(anon)') + ' ' + where(n.callFrame.url, n.callFrame.lineNumber);
const ms = v => (v / 1000 / ticks).toFixed(2).padStart(7);
let tickTotal = 0;
const stats = new Map(phases.map(ph => [ph, { total: 0, incl: new Map(), self: new Map() }]));
for (const [id, t] of self) {
    if (String(top(id)) !== want) continue;
    tickTotal += t;
    // The innermost listed phase above this sample.
    const chain = [];
    for (let x = id; x !== undefined; x = parent.get(x)) chain.push(byId.get(x));
    let pi = -1;
    for (let i = 0; i < chain.length; i++) if (stats.has(chain[i].callFrame.functionName)) { pi = i; break; }
    if (pi < 0) continue;
    const S = stats.get(chain[pi].callFrame.functionName);
    S.total += t;
    const k0 = name(chain[0]);
    S.self.set(k0, (S.self.get(k0) || 0) + t);
    const seen = new Set();
    for (let i = 0; i < pi; i++) { const k = name(chain[i]); if (seen.has(k)) continue; seen.add(k); S.incl.set(k, (S.incl.get(k) || 0) + t); }
}
console.log(which, 'thread: ' + ms(tickTotal).trim() + ' ms a tick in the profile (sampling adds some)');
for (const [ph, S] of stats) {
    console.log('\n' + ms(S.total) + ' ms  ' + ph);
    console.log('   inclusive:');
    for (const [k, v] of [...S.incl].sort((a, b) => b[1] - a[1]).slice(0, topN)) console.log('   ' + ms(v) + '  ' + k);
    console.log('   self:');
    for (const [k, v] of [...S.self].sort((a, b) => b[1] - a[1]).slice(0, topN)) console.log('   ' + ms(v) + '  ' + k);
}
