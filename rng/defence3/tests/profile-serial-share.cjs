// Main-thread time by tick phase, split into JavaScript (serial: helpers run
// wasm only), wasm (a kernel: this thread's chunks, or a single job) and
// the rest (GC, program), from a chaos bench run captured with --profile.
// The top JavaScript functions of each phase show what scales with counts.
// node tests/profile-serial-share.cjs run.json [--from=STEP] [--to=STEP] [--top=6]
'use strict';
const fs = require('node:fs'), path = require('node:path');
const file = path.resolve(process.argv[2]);
const opt = k => process.argv.find(a => a.startsWith('--' + k + '='))?.split('=')[1];
const run = JSON.parse(fs.readFileSync(file)), profile = JSON.parse(fs.readFileSync(file + '.cpuprofile'));
const from = Number(opt('from') ?? run.profileOrigins?.startStep ?? 0), to = Number(opt('to') ?? Infinity), top = Number(opt('top') || 6);
const rows = run.rows.filter(r => r.step >= from && r.step <= to);
// (Phases: the names the bench times, outermost first; a stack's phase is
// its outermost frame with one of them below gameTick.)
const phases = new Set();
for (const r of rows) for (const k of Object.keys(r.phases || {})) if (!/^(kernel|wait):|^gameTick$/.test(k)) phases.add(k);
const nodes = new Map(profile.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of profile.nodes) for (const id of n.children || []) parent.set(id, n.id);
// (The game runs as eval'd code, without a url; wasm frames have wasm:// ones.)
const kind = f => /^wasm:/.test(f.url || '') ? 'wasm' : /^\(/.test(f.functionName || '') ? 'other' : 'js';
const memo = new Map();
function phaseOf(id) {
    if (memo.has(id)) return memo.get(id);
    let p = null;
    for (let at = id; at !== undefined; at = parent.get(at)) { const name = nodes.get(at).callFrame.functionName; if (phases.has(name)) p = name; }
    memo.set(id, p);
    return p;
}
// Sample times: profile time (us) relative to the bench's clock (ms).
const origin = run.profileOrigins.main;
const windows = rows.map(r => [r.at - origin, r.at - origin + (r.wallMs ?? r.ms)]);
const inRows = t => { for (const [a, b] of windows) if (t >= a && t < b) return true; return false; };
const out = new Map();
let t = profile.startTime / 1000, total = 0;
for (let i = 0; i < profile.samples.length; i++) {
    t += profile.timeDeltas[i] / 1000;
    const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i]) / 1000;
    const ms = t - profile.startTime / 1000;
    if (!inRows(ms)) continue;
    const id = profile.samples[i], n = nodes.get(id), f = n.callFrame;
    if (f.functionName === '(idle)') continue;
    const p = phaseOf(id) || '(no phase)', k = kind(f);
    let e = out.get(p);
    if (!e) out.set(p, e = { js: 0, wasm: 0, other: 0, fns: new Map() });
    e[k] += dt; total += dt;
    if (k === 'js') { const name = (f.functionName || '(anonymous)') + ':' + (f.lineNumber + 1); e.fns.set(name, (e.fns.get(name) || 0) + dt); }
}
const per = 1 / rows.length;
console.log(`steps ${from}..${Math.min(to, rows.at(-1)?.step)}: ${rows.length} ticks, sampled ${(total * per).toFixed(1)} ms a tick (ms a tick: js / wasm / other)`);
for (const [p, e] of [...out].sort((a, b) => b[1].js - a[1].js)) {
    if (e.js + e.wasm + e.other < 0.5 * rows.length) continue;
    console.log(`${p.padEnd(34)} ${(e.js * per).toFixed(1).padStart(6)} ${(e.wasm * per).toFixed(1).padStart(6)} ${(e.other * per).toFixed(1).padStart(6)}`);
    for (const [name, ms] of [...e.fns].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log('      ' + (ms * per).toFixed(2).padStart(6) + '  ' + name);
}
