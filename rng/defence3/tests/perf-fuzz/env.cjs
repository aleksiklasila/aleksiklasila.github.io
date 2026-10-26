'use strict';
// Plumbing shared by the perf fuzzer: option parsing, playwright lookup, the
// static game server, a seeded generator, small time helpers.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..', '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --name=value (or --name, true) beats the env var NAME (dashes to underscores).
function makeOpts(argv) {
    const flags = new Map(), positional = [];
    for (const a of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
        if (m) flags.set(m[1], m[2] === undefined ? 'true' : m[2]); else positional.push(a);
    }
    const raw = name => flags.has(name) ? flags.get(name) : process.env[name.toUpperCase().replace(/-/g, '_')];
    const opt = (name, def) => { const v = raw(name); return v === undefined || v === '' ? def : v; };
    const num = (name, def) => { const v = Number(raw(name)); return Number.isFinite(v) && raw(name) !== undefined && raw(name) !== '' ? v : def; };
    const bool = (name, def) => { const v = raw(name); if (v === undefined || v === '') return def; return !/^(0|false|no|off)$/i.test(v); };
    const list = (name, def) => { const v = raw(name); return v === undefined || v === '' ? def : String(v).split(',').map(s => s.trim()).filter(Boolean); };
    return { opt, num, bool, list, positional, flags };
}

// playwright is not a dependency of the repo: NODE_PATH, PLAYWRIGHT_DIR, or a
// copy that is known to exist on the dev machine.
function loadPlaywright() {
    const dirs = [process.env.PLAYWRIGHT_DIR, ...String(process.env.NODE_PATH || '').split(path.delimiter), 'Z:/data/Antigravity/resources/app/node_modules'].filter(Boolean);
    try { return require('playwright'); } catch { }
    for (const d of dirs) {
        try { return require(require.resolve('playwright', { paths: [d] })); } catch { }
    }
    throw new Error('playwright not found: set PLAYWRIGHT_DIR (a node_modules folder holding it) or NODE_PATH');
}

const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.webp': 'image/webp', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
function startServer() {
    const server = http.createServer((req, res) => {
        let file;
        try { file = path.resolve(root, decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html'); } catch { res.writeHead(400).end(); return; }
        if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store',
                'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
            res.end(data);
        });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// Small deterministic generator (the same one the other fuzzers use) with
// the helpers the actions need.
function makeRng(seed) {
    let s = (Number(seed) >>> 0) || 1;
    const next = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const rng = {
        next,
        get seed() { return s; },
        range: (a, b) => a + next() * (b - a),
        int: (a, b) => a + Math.floor(next() * (b - a + 1)),
        chance: p => next() < p,
        pick: list => list[Math.floor(next() * list.length)],
        weighted: (items, weightOf) => {
            let total = 0;
            for (const it of items) total += Math.max(0, weightOf(it));
            let r = next() * total;
            for (const it of items) { r -= Math.max(0, weightOf(it)); if (r <= 0) return it; }
            return items[items.length - 1];
        },
        shuffle: list => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; },
    };
    return rng;
}

const withTimeout = (promise, ms, what) => {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout after ' + ms + ' ms: ' + what), { timeout: true })), ms); });
    return Promise.race([promise, t]).finally(() => clearTimeout(timer));
};

const round = (v, d = 1) => v === null || v === undefined || !Number.isFinite(v) ? v : Math.round(v * 10 ** d) / 10 ** d;
const median = a => { if (!a.length) return NaN; const b = a.slice().sort((x, y) => x - y), n = b.length; return n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2; };
const quantile = (a, p) => { if (!a.length) return NaN; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;

module.exports = { root, sleep, makeOpts, loadPlaywright, startServer, makeRng, withTimeout, round, median, quantile, mean };
