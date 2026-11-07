// Self time in .cpuprofile files, attributed: an unnamed wasm frame
// (wasm-function[N], a stripped internal) to its nearest named ancestor (the
// exported kernel), any other frame to its caller chain (3 levels). Wasm
// indices are read against the binary the profile was taken with: pass the
// sim_wasm_bin.js of that build (a rebuild renumbers them).
//   node tests/profile-attrib.cjs <sim_wasm_bin.js> <profile dir> <file regex> [frame regex=.] [--top=15]
//   e.g. node tests/profile-attrib.cjs run/sim_wasm_bin.js run/profiles "sim_worker" "^occ_spawn|^wasm-function"
'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const wasmProfileExports = require('./wasm-profile-exports.cjs');
const pos = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [binFile, dir, fileRe, frameRe = '.'] = pos;
const top = +(process.argv.find(a => a.startsWith('--top=')) || '--top=15').slice(6);
if (!binFile || !dir || !fileRe) { console.error('usage: node tests/profile-attrib.cjs <sim_wasm_bin.js> <profile dir> <file regex> [frame regex] [--top=15]'); process.exit(2); }
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(binFile, 'utf8') + ';this.B=SIM_WASM_BIN;', ctx);
const names = wasmProfileExports(Array.isArray(ctx.B) ? ctx.B.join('') : ctx.B);
const label = n => {
    const f = n.callFrame, m = /^wasm-function\[(\d+)\]$/.exec(f.functionName);
    if (m) return names[+m[1]] || f.functionName;
    return (f.functionName || '(anon)') + ' ' + path.basename(f.url || '').replace(/\?.*$/, '') + ':' + (f.lineNumber + 1);
};
const agg = new Map(), want = new RegExp(frameRe);
for (const file of fs.readdirSync(dir).filter(x => new RegExp(fileRe).test(x) && x.endsWith('.cpuprofile'))) {
    const P = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const byId = new Map(P.nodes.map(n => [n.id, n])), parent = new Map();
    for (const n of P.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
    const self = new Map(), dt = P.timeDeltas || [];
    for (let i = 0; i < P.samples.length; i++) self.set(P.samples[i], (self.get(P.samples[i]) || 0) + (dt[i] || 0) / 1000);
    for (const [id, ms] of self) {
        const l = label(byId.get(id));
        if (!want.test(l)) continue;
        const unnamed = /^wasm-function\[/.test(l), chain = [];
        let p = parent.get(id), owner = null;
        while (p !== undefined) {
            const pl = label(byId.get(p));
            if (unnamed && !owner && !/^wasm-function\[/.test(pl)) { owner = pl; break; }
            if (!unnamed) { chain.push(pl); if (chain.length >= 3) break; }
            p = parent.get(p);
        }
        const key = l + '  <=  ' + (unnamed ? 'in ' + owner : chain.join(' < '));
        agg.set(key, (agg.get(key) || 0) + ms);
    }
}
for (const [k, ms] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(ms.toFixed(0).padStart(7) + ' ms  ' + k);
