// Local-only diagnostic preview: node tests/ui-stress-server.cjs
// Open http://127.0.0.1:8125/?stress=1 (add &baseline=1 for Git HEAD).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const prefix = execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: root, encoding: 'utf8' }).trim();
const reference = execFileSync('git', ['rev-parse', process.env.DEFENCE_BENCH_BASELINE || 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const baseline = new Map();
const reports = [];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.json': 'application/json' };
http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__reports' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 2e6) req.destroy(); });
        req.on('end', () => { try { const report = JSON.parse(body); reports.push(report); console.log(JSON.stringify(report)); res.end('ok'); } catch { res.writeHead(400).end(); } });
        return;
    }
    if (url.pathname === '/__reports') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reports)); return; }
    let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if (file === root) file = path.join(root, 'index.html');
    try {
        let data;
        const relative = path.relative(root, file).replaceAll('\\', '/');
        if (url.searchParams.has('baseline') && relative.startsWith('src/')) {
            if (!baseline.has(relative)) baseline.set(relative, execFileSync('git', ['show', reference + ':' + prefix + relative], { cwd: root, maxBuffer: 8e6 }));
            data = baseline.get(relative);
        } else data = fs.readFileSync(file);
        if (relative === 'index.html' && url.searchParams.has('stress')) {
            data = data.toString();
            if (url.searchParams.has('baseline')) data = data.replace(/(src="\.\/src\/[^"?]+)(?:\?[^\"]*)?"/g, '$1?baseline=1"');
            data = data.replace('</body>', '<script src="./tests/ui-stress.js"></script></body>');
        }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
    } catch (err) { res.writeHead(404).end(String(err.message)); }
}).listen(8125, '127.0.0.1', () => console.log('UI diagnostics: http://127.0.0.1:8125/?stress=1'));
