// The unit column census's report (chaos-spikes.bench.cjs --census=...):
// node tests/unit-column-census-report.cjs run.json.census.json [profile-run.json] [--md=out.md]
// Per per-slot array: bytes a slot, its value profile, who writes it (64-byte
// lines changed a census tick) and who binds it; per caller: lines written,
// per-slot bytes bound, and its time from a profiled run of the scene
// (phases kernel:<id>, mean over steady steps). Flags: const (one value, never
// written), narrow (values fit a smaller type), bool (two values in a wider
// type), sparse (<10% of slots off their common value).
'use strict';
const fs = require('fs'), path = require('path');
const C = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const profFile = process.argv.slice(3).find(a => !a.startsWith('--'));
const mdOut = process.argv.find(a => a.startsWith('--md='))?.slice(5);
const ticks = C.ticks.length;
// (Kernel ids -> names from sim_parallel.js; the profile's per-kernel means.)
const src = fs.readFileSync(path.join(__dirname, '../src/sim/sim_parallel.js'), 'utf8');
const kid = {}; for (const m of src.matchAll(/SIM_KERNEL_([A-Z0-9_]+)\s*=\s*(\d+)/g)) kid[m[1]] = m[2];
let prof = null;
if (profFile) {
    const r = JSON.parse(fs.readFileSync(profFile, 'utf8')), rows = r.rows.filter(w => w.step >= (r.warmup || 0));
    prof = {}; for (const w of rows) for (const [k, v] of Object.entries(w.phases || {})) prof[k] = (prof[k] || 0) + v / rows.length;
}
const timeOf = label => {
    if (!prof) return null;
    if (label.startsWith('k:')) { const n = label.slice(2), id = kid[n] || n; let t = 0; for (const [k, v] of Object.entries(prof)) if (k === 'kernel:' + id || k.startsWith('kernel:' + id + ':')) t += v; return t; }
    if (label.startsWith('d:')) return prof['rust:' + label.slice(2)] ?? null;
    return null;
};
const A = C.arrays, names = Object.keys(A);
const wr = {}, bd = {};
for (const n of names) { wr[n] = []; bd[n] = []; }
for (const [l, x] of Object.entries(C.labels)) {
    for (const [n, v] of Object.entries(x.writes)) if (wr[n]) wr[n].push([l, v.lines / ticks, v.elements / ticks]);
    for (const n of x.binds) if (bd[n]) bd[n].push(l);
}
const typeFits = (a) => {
    if (a.type.startsWith('Float')) return null;
    const { min, max } = a;
    if (!(isFinite(min) && isFinite(max))) return null;
    const need = min >= 0 ? (max < 2 ? 0.125 : max < 256 ? 1 : max < 65536 ? 2 : 4) : (min >= -128 && max < 128 ? 1 : min >= -32768 && max < 32768 ? 2 : 4);
    return need;
};
const lines = [];
const out = s => lines.push(s);
const cap = C.cap;
let totB = 0; for (const n of names) totB += A[n].bytesPerSlot;
out(`# Unit column census\n\nTicks ${C.ticks.join(', ')}; slots ${C.slots} of ${cap}, live ${C.liveSlots}. Per-slot arrays ${names.length}: ${totB} B a slot (${(totB * cap / 1048576).toFixed(0)} MB at cap).\n`);
// Per array.
const rowsA = names.map(n => {
    const a = A[n], w = wr[n], wl = w.reduce((s, x) => s + x[1], 0);
    const fit = typeFits(a), flags = [];
    if (a.distinct === 1 && !w.length) flags.push('const');
    else if (a.distinct === 1) flags.push('uniform');
    if (a.distinct === 2 && a.bpe > 1 && !a.type.startsWith('Float')) flags.push('bool');
    else if (fit !== null && fit < a.bpe) flags.push('narrow->' + (fit < 1 ? 'bit' : fit + 'B'));
    if (a.nonDefault < 0.1) flags.push('sparse ' + (a.nonDefault * 100).toFixed(1) + '%');
    if (!bd[n].length && !w.length) flags.push('no kernel');
    return { n, a, wl, w, flags };
}).sort((x, y) => y.wl - x.wl || y.a.bytesPerSlot - x.a.bytesPerSlot);
out('## Arrays (by lines written a tick)\n');
out('| array | type | B/slot | range | distinct | non-default | lines written/tick | writers (lines) | binders | flags |');
out('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rowsA) {
    const a = r.a;
    const writers = r.w.sort((x, y) => y[1] - x[1]).slice(0, 4).map(x => x[0].replace(/^js after /, 'js<') + ' ' + x[1].toFixed(0)).join(', ');
    const binders = bd[r.n].filter(l => l.startsWith('k:') || l.startsWith('d:') || l.startsWith('bg:'));
    out(`| ${r.n}${a.alias ? ' (' + a.alias + ')' : ''} | ${a.type}${a.stride > 1 ? 'x' + a.stride : ''} | ${a.bytesPerSlot} | ${a.min}..${a.max} | ${a.distinct} | ${(a.nonDefault * 100).toFixed(1)}% | ${r.wl.toFixed(0)} | ${writers} | ${binders.length} | ${r.flags.join(' ')} |`);
}
// Per caller.
out('\n## Callers (by lines written a tick)\n');
out('| caller | calls/tick | ms (profile) | lines written/tick | arrays written | per-slot B bound | top written |');
out('|---|---|---|---|---|---|---|');
const rowsL = Object.entries(C.labels).map(([l, x]) => {
    const wlines = Object.values(x.writes).reduce((s, v) => s + v.lines, 0) / ticks;
    const bB = x.binds.reduce((s, n) => s + (A[n] ? A[n].bytesPerSlot : 0), 0);
    return { l, x, wlines, bB };
}).filter(r => r.wlines > 0 || r.bB > 0).sort((p, q) => q.wlines - p.wlines);
for (const r of rowsL) {
    const t = timeOf(r.l);
    const top = Object.entries(r.x.writes).sort((p, q) => q[1].lines - p[1].lines).slice(0, 5).map(([n, v]) => n + ' ' + (v.lines / ticks).toFixed(0)).join(', ');
    out(`| ${r.l} | ${(r.x.calls / ticks).toFixed(1)} | ${t === null ? '' : t.toFixed(2)} | ${r.wlines.toFixed(0)} | ${Object.keys(r.x.writes).length} | ${r.bB} | ${top} |`);
}
// Totals by flag.
const sumB = f => rowsA.filter(f).reduce((s, r) => s + r.a.bytesPerSlot, 0);
out(`\n## Totals\n\n- const (one value, never written): ${sumB(r => r.flags.includes('const'))} B/slot over ${rowsA.filter(r => r.flags.includes('const')).length} arrays`);
out(`- bound by no kernel and never written: ${sumB(r => r.flags.includes('no kernel'))} B/slot`);
out(`- sparse (<10% non-default): ${sumB(r => r.flags.some(f => f.startsWith('sparse')))} B/slot`);
out(`- narrowable or bool: ${rowsA.filter(r => r.flags.some(f => f.startsWith('narrow') || f === 'bool')).reduce((s, r) => { const f = r.flags.find(f => f.startsWith('narrow') || f === 'bool'); const to = f === 'bool' || f.endsWith('bit') ? 0.125 : +f.split('->')[1].replace('B', ''); return s + (r.a.bpe - to) * r.a.stride; }, 0).toFixed(1)} B/slot saved`);
out(`- lines written a tick, all callers: ${rowsL.reduce((s, r) => s + r.wlines, 0).toFixed(0)} (${(rowsL.reduce((s, r) => s + r.wlines, 0) * 64 / 1048576).toFixed(1)} MB)`);
const text = lines.join('\n');
if (mdOut) fs.writeFileSync(mdOut, text);
console.log(text.length > 60000 ? text.slice(0, 60000) + '\n...' : text);
