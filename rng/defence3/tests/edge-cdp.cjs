// Edge (or another Chromium: EDGE=path) driven over its debugging protocol,
// with no other dependency: launch(url, { width, height }) opens the page
// headless and returns { ev(expression), evFn(fn), errors, close() }.
// ev awaits promises and returns values by value; errors collects the
// page's uncaught exceptions (Runtime.exceptionThrown). null from
// launch when Edge is not installed (callers skip).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launch(url, { width = 1280, height = 800, timeoutMs = 120000 } = {}) {
    if (!fs.existsSync(EDGE)) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'defence-edge-'));
    const port = 9950 + Math.floor(Math.random() * 40);
    const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        `--window-size=${width},${height}`, '--disable-features=CalculateNativeWinOcclusion', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let page;
    for (let i = 0; i < 100 && !page; i++) {
        try { page = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json()).find(t => t.type === 'page'); } catch {}
        if (!page) await sleep(200);
    }
    if (!page) { try { proc.kill(); } catch {} throw new Error('Edge debug endpoint did not open'); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    let id = 0;
    const pending = new Map(), errors = [];
    ws.onmessage = m => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) { const p = pending.get(d.id); clearTimeout(p.timer); pending.delete(d.id); p.resolve(d); return; }
        if (d.method === 'Runtime.exceptionThrown') {
            const e = d.params.exceptionDetails || {};
            errors.push((e.exception && (e.exception.description || e.exception.value)) || e.text || 'exception');
        }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const i = ++id;
        const timer = setTimeout(() => { pending.delete(i); reject(new Error('CDP timeout: ' + method + ' ' + String(params.expression || '').slice(0, 120))); }, timeoutMs);
        pending.set(i, { resolve, reject, timer });
        ws.send(JSON.stringify({ id: i, method, params }));
    });
    ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Edge connection closed')); } pending.clear(); };
    const ev = async expression => {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) {
            const e = r.result.exceptionDetails;
            throw new Error((e.exception && (e.exception.description || e.exception.value)) || JSON.stringify(e).slice(0, 600));
        }
        return r.result.result.value;
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url });
    for (let i = 0; i < 150; i++) { await sleep(200); try { if (await ev(`document.readyState === 'complete'`)) break; } catch {} }
    // Edge runs as a tree of processes: ask it to exit, then make sure the
    // whole tree is gone.
    const close = async () => {
        try { await Promise.race([send('Browser.close'), sleep(2000)]); } catch {}
        try { ws.close(); } catch {}
        await sleep(300);
        if (process.platform === 'win32') { try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
        else { try { process.kill(-proc.pid); } catch {} try { proc.kill('SIGKILL'); } catch {} }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    };
    return { ev, evFn: fn => ev(`(${fn.toString()})()`), errors, close };
}

module.exports = { launch, EDGE };
