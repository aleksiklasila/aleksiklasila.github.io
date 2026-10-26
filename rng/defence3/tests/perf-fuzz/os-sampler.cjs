'use strict';
// Node side of os-sampler.ps1: sample(tag, { gpu }) -> the machine's and the
// browser tree's memory / CPU numbers, or null (not Windows, or the sampler
// failed: callers carry on without OS numbers).
const path = require('node:path');
const { spawn } = require('node:child_process');
const { withTimeout } = require('./env.cjs');

function startOsSampler() {
    if (process.platform !== 'win32') return { sample: async () => null, close() { }, available: false };
    const proc = spawn('powershell', ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'os-sampler.ps1')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buf = '', waiting = null, dead = false;
    proc.stdout.on('data', d => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line || !waiting) continue;
            const w = waiting; waiting = null;
            try { w.resolve(JSON.parse(line)); } catch { w.resolve(null); }
        }
    });
    proc.on('exit', () => { dead = true; if (waiting) { waiting.resolve(null); waiting = null; } });
    let chain = Promise.resolve();
    const sample = (tag, { gpu = false } = {}) => {
        const run = async () => {
            if (dead) return null;
            const answer = new Promise(resolve => { waiting = { resolve }; });
            proc.stdin.write(JSON.stringify({ tag, gpu }) + '\n');
            try { return await withTimeout(answer, gpu ? 20000 : 12000, 'os sampler'); } catch { waiting = null; return null; }
        };
        chain = chain.then(run, run);
        return chain;
    };
    return { sample, close() { try { proc.stdin.end(); } catch { } try { proc.kill(); } catch { } }, available: true };
}

module.exports = { startOsSampler };
