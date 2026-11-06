'use strict';
// Every tests/*.test.cjs, a few at a time, each with a timeout: pass/fail
// per file into tests/test-runs/run-all/<stamp>/ (a log a test, summary.json).
// Usage: node tests/run-all.cjs [--jobs=4] [--timeout=1200] [--only=a,b]
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const jobs = +arg('jobs', 4), timeout = +arg('timeout', 1200) * 1000, only = arg('only', '');
const dir = __dirname, out = path.join(dir, 'test-runs', 'run-all', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true });
let files = fs.readdirSync(dir).filter(f => f.endsWith('.test.cjs')).sort();
if (only) { const set = new Set(only.split(',').map(s => s.endsWith('.test.cjs') ? s : s + '.test.cjs')); files = files.filter(f => set.has(f)); }
const results = [];
let next = 0, running = 0;
const t0 = Date.now();
function start() {
    while (running < jobs && next < files.length) {
        const f = files[next++], log = fs.openSync(path.join(out, f + '.log'), 'w'), t = Date.now();
        running++;
        const p = spawn(process.execPath, ['--max-old-space-size=6144', path.join(dir, f)], { cwd: path.join(dir, '..'), stdio: ['ignore', log, log] });
        const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
        // (A spawn that failed (Windows: UNKNOWN, a busy moment): tried again shortly.)
        p.on('error', () => { clearTimeout(timer); try { fs.closeSync(log); } catch (e) {} running--; next--; files.splice(next, 0, files.splice(next, 1)[0]); setTimeout(start, 2000); });
        p.on('exit', (code, sig) => {
            clearTimeout(timer); fs.closeSync(log); running--;
            const r = { file: f, code, timedOut: sig === 'SIGKILL', s: Math.round((Date.now() - t) / 1000) };
            results.push(r);
            console.log((code === 0 ? 'PASS ' : r.timedOut ? 'TIME ' : 'FAIL ') + f + ' ' + r.s + 's  [' + results.length + '/' + files.length + ']');
            if (results.length === files.length) finish(); else start();
        });
    }
}
function finish() {
    results.sort((a, b) => a.file < b.file ? -1 : 1);
    const failed = results.filter(r => r.code !== 0);
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ total: results.length, failed: failed.length, minutes: +((Date.now() - t0) / 60000).toFixed(1), results }, null, 1));
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed; failed: ' + failed.map(r => r.file + (r.timedOut ? ' (timeout)' : '')).join(', '));
    console.log('logs: ' + out);
}
start();
