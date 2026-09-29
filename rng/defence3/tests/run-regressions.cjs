// Run independent regression files with bounded concurrency. Timings from this
// runner are NOT benchmarks; run performance measurements on their own.
// node tests/run-regressions.cjs [concurrency=3] [--resume]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const option = (name, fallback) => (process.argv.find(a=>a.startsWith('--'+name+'='))||'').split('=').slice(1).join('=')||fallback;
const output = path.join(__dirname, option('output','shared-state-final-validation.json'));
const filter = new RegExp(option('filter',''));
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.cjs') && filter.test(f));
let rows = [];
if (process.argv.includes('--resume')) {
    for (const name of ['shared-state-validation.json', 'shared-state-final-validation.json']) {
        try { rows.push(...JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8')).filter(r => r.status === 0)); } catch {}
    }
}
rows = [...new Map(rows.map(r => [r.mode + '/' + r.file, r])).values()];
const done = new Set(rows.map(r => r.mode + '/' + r.file));
const jobs = option('modes','0,1').split(',').flatMap(mode => files.map(file => ({ mode, file }))).filter(r => !done.has(r.mode + '/' + r.file));
let next = 0;
async function worker() {
    while (next < jobs.length) {
        const { mode, file } = jobs[next++];
        const row = await new Promise(resolve => {
            const started = Date.now();
            const child = spawn(process.execPath, [path.join(__dirname, file)], { env: { ...process.env, SIM_WORKER: mode }, windowsHide: true });
            let text = '', timedOut = false;
            const timer = setTimeout(() => { timedOut = true; child.kill(); }, 600000);
            child.stdout.on('data', b => { text += b; }); child.stderr.on('data', b => { text += b; });
            child.on('error', e => { text += String(e); });
            child.on('close', status => { clearTimeout(timer); resolve({ mode, file, status, output: text, timedOut, elapsedMs:Date.now()-started }); });
        });
        rows.push(row); fs.writeFileSync(output, JSON.stringify(rows, null, 2) + '\n');
        console.log(row.mode, row.file, row.status === 0 ? 'PASS' : 'FAIL');
    }
}
Promise.all(Array.from({ length: Math.max(1, Number(process.argv[2]) || 3) }, worker)).then(() => {
    console.log(`${rows.filter(r => r.status === 0).length}/${rows.length} passed`);
    process.exitCode = rows.some(r => r.status !== 0) ? 1 : 0;
});
