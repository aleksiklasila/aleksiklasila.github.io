'use strict';
// The simulation thread's time a step from its cpuprofile: under a parallel dispatch (shared with helpers) or serial
// (JS, or wasm called directly), and the serial part's largest owners (outermost named frame under _gameTickBody).
const fs = require('node:fs');
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), steps = Number(process.argv[3]) || 1;
const nodes = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const tot = { par: 0, bgwait: 0, serialJs: 0, serialWasm: 0, other: 0 }, owner = {}, kern = {};
for (let k = 0; k < p.samples.length; k++) {
    const id = p.samples[k], d = p.timeDeltas[k] || 0, f = nodes.get(id).callFrame;
    const st = []; for (let q = id; q !== undefined; q = parent.get(q)) st.push(nodes.get(q).callFrame);
    const names = st.map(c => c.functionName);
    if (!names.includes('gameTick')) continue;
    const isWasm = /^wasm:/.test(f.url || '');
    let cls;
    if (names.includes('simParallelBackgroundWait')) cls = 'bgwait';
    else if (names.includes('simParallelRun')) cls = 'par';
    else if (/^\(/.test(f.functionName || '')) cls = 'other';
    else cls = isWasm ? 'serialWasm' : 'serialJs';
    tot[cls] += d;
    if (cls === 'serialJs' || cls === 'serialWasm') {
        // (the frame just under _gameTickBody, and the one under that)
        const i = names.lastIndexOf('_gameTickBody');
        const a = i > 0 ? names[i - 1] : names[names.length - 1], b = i > 1 ? names[i - 2] : '';
        const key = (a || '(anon)') + (b ? ' > ' + b : '');
        owner[key] = (owner[key] || 0) + d;
        if (isWasm) { const w = st.find(c => /^wasm:/.test(c.url || '') && !/^_R/.test(c.functionName)); const n = w ? w.functionName : f.functionName; kern[n] = (kern[n] || 0) + d; }
    }
}
const ms = v => Math.round(v / 1000 / steps * 10) / 10;
console.log('a step:', Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, ms(v)])));
console.log('serial owners:'); for (const [k, v] of Object.entries(owner).sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(String(ms(v)).padStart(7), k);
console.log('serial wasm by kernel:'); for (const [k, v] of Object.entries(kern).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(String(ms(v)).padStart(7), k);
