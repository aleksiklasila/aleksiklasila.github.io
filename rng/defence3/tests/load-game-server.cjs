'use strict';
// Plain local game hosting, with shared-memory headers. No benchmark runner.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..'), port = Number(process.argv[2]) || 8127;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
http.createServer((req, res) => {
    let file;
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    } catch { res.writeHead(400).end(); return; }
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, body) => {
        if (error) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless',
            'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' }).end(body);
    });
}).listen(port, '127.0.0.1', () => console.log(`Game: http://127.0.0.1:${port}/?loadmetrics=1&loadfixture=2m`));
