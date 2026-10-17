'use strict';
// One UI action at a time in a running match, in Microsoft Edge (headed,
// hardware WebGL): the longest frame and page task after it, the ticks
// around it, and a CPU profile of its busiest stretch (total and self ms per
// function), to find what a spike is made of.
//   NODE_PATH=<dir with playwright> node tests/action-spike.cjs <fixture> <action>...
// Actions: click:<css selector> | select:<css selector>=<value> (set, then input+change:
//          works in closed popups) | key:<key> |
//          eval:<page JS> (each may end in xN: repeated N times, e.g. 'select:#btn-render-range=4x2')
//   env: SETTLE_MS (after each action, default 2500), TOP (functions listed, 14),
//        VIEW=3d (switch to 3D first), QUERY (page URL query), SHOT=<path.png>
//        (a screenshot after each action: path-<n>.png), TRACE=1 (a Chrome trace of
//        each action: its longest events over 5 ms, any thread, by name)
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html';
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
        res.end(data);
    });
});

// The busiest stretch of a profile (no idle sample for > 2 ms): inclusive
// and self ms per function inside it.
function busiest(p, top) {
    const byId = new Map(p.nodes.map(n => [n.id, n])), parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const name = n => `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url || '').replace(/\?.*/, '')}:${n.callFrame.lineNumber + 1}`;
    let t = p.startTime, best = null, cur = null;
    for (let i = 0; i < p.samples.length; i++) {
        t += p.timeDeltas[i];
        const idle = /\(idle\)/.test(byId.get(p.samples[i]).callFrame.functionName);
        if (!idle) { if (!cur) cur = { start: t, end: t, idx: [] }; cur.end = t; cur.idx.push(i); }
        else if (cur && t - cur.end > 2000) { if (!best || cur.end - cur.start > best.end - best.start) best = cur; cur = null; }
    }
    if (cur && (!best || cur.end - cur.start > best.end - best.start)) best = cur;
    if (!best) return '    (no busy stretch)';
    const self = new Map(), total = new Map();
    for (const i of best.idx) {
        const dt = (p.timeDeltas[i + 1] || 0) / 1000;
        let id = p.samples[i];
        self.set(name(byId.get(id)), (self.get(name(byId.get(id))) || 0) + dt);
        const seen = new Set();
        for (; id !== undefined; id = parent.get(id)) { const k = name(byId.get(id)); if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) || 0) + dt); } }
    }
    const rows = m => [...m].filter(([k]) => !/^\(root\)|^\(idle\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `      ${v.toFixed(1).padStart(6)}  ${k}`).join('\n');
    return `    busiest stretch ${((best.end - best.start) / 1000).toFixed(0)} ms\n    total:\n${rows(total)}\n    self:\n${rows(self)}`;
}

(async () => {
    const [fixture, ...actions] = process.argv.slice(2);
    if (!fixture || !actions.length) { console.log('usage: action-spike.cjs <fixture> <action>...'); return; }
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ channel: 'msedge', headless: false });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 300)));
    page.on('dialog', d => d.dismiss().catch(() => {}));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html${process.env.QUERY ? '?' + process.env.QUERY : ''}`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await page.evaluate(async fixture => {
        applyMainMenuSettingsSnapshot(await (await fetch('tests/' + fixture)).json());
        startSoloGame();
    }, fixture);
    await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 300000 });
    if (process.env.VIEW === '3d') await page.evaluate(() => setRenderDimensionMode('3d'));
    await page.evaluate(() => {
        window.__as = { frames: [], tasks: [], last: performance.now() };
        const frame = now => { __as.frames.push([now, now - __as.last]); __as.last = now; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        new PerformanceObserver(list => { for (const e of list.getEntries()) __as.tasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false });
    });
    await page.waitForTimeout(3000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    const settle = Number(process.env.SETTLE_MS) || 2500, top = Number(process.env.TOP) || 14;
    for (const spec of actions) {
        const m = /^(.*?)(?:x(\d+))?$/.exec(spec);
        const action = m[1], times = Number(m[2]) || 1;
        for (let k = 0; k < times; k++) {
            if (process.env.TRACE) await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'viz', 'v8.execute'] });
            await cdp.send('Profiler.start');
            const before = await page.evaluate(() => ({ at: performance.now(), tick: simClientStats().appliedTick }));
            const [kind, ...rest] = action.split(':'); const arg = rest.join(':');
            if (kind === 'click') await page.click(arg);
            else if (kind === 'select') { const i = arg.lastIndexOf('='); await page.evaluate(([sel, v]) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, [arg.slice(0, i), arg.slice(i + 1)]); }
            else if (kind === 'key') await page.keyboard.press(arg);
            else if (kind === 'eval') await page.evaluate(arg);
            await page.waitForTimeout(settle);
            const { profile } = await cdp.send('Profiler.stop');
            let traceLines = '';
            if (process.env.TRACE) {
                const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents || [];
                const names = new Map(events.filter(e => e.name === 'thread_name').map(e => [e.pid + ':' + e.tid, e.args.name]));
                const rows = events.filter(e => e.ph === 'X' && e.dur > 5000).map(e => [e.dur / 1000, (names.get(e.pid + ':' + e.tid) || '?') + ' ' + e.name]);
                const byName = new Map();
                for (const [d, k] of rows) { const v = byName.get(k) || { n: 0, max: 0 }; v.n++; v.max = Math.max(v.max, d); byName.set(k, v); }
                traceLines = [...byName].sort((a, b) => b[1].max - a[1].max).slice(0, 14).map(([k, v]) => `      ${v.max.toFixed(0).padStart(5)} ms x${v.n}  ${k}`).join('\n');
            }
            const r = await page.evaluate(at => {
                const frames = __as.frames.filter(f => f[0] >= at), tasks = __as.tasks.filter(t => t[0] + t[1] >= at);
                return { maxFrame: Math.max(0, ...frames.map(f => f[1])), over50: frames.filter(f => f[1] > 50).length, maxTask: Math.max(0, ...tasks.map(t => t[1])), tick: simClientStats().appliedTick };
            }, before.at);
            console.log(`${action}${times > 1 ? ' #' + (k + 1) : ''}: longest frame ${r.maxFrame.toFixed(0)} ms, frames over 50 ms ${r.over50}, longest task ${r.maxTask.toFixed(0)} ms, ticks ${r.tick - before.tick} in ${(settle / 1000).toFixed(1)} s`);
            if (r.maxFrame > 34 || r.maxTask > 0) console.log(busiest(profile, top));
            if (traceLines && r.maxFrame > 34) console.log('    trace (longest event per name):\n' + traceLines);
            if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace(/.png$/, `-${actions.indexOf(spec) + 1}${times > 1 ? '-' + (k + 1) : ''}.png`) });
        }
    }
    console.log('errors', errors.slice(0, 5));
    await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
