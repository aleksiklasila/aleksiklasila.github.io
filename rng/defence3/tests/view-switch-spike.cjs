'use strict';
// The 2D <-> 3D view switch in a running match, in Microsoft Edge (headed,
// hardware WebGL): the longest frame and page task after a real click on the
// view buttons, the first switch and later ones, and the tick rate around
// them. PROFILE=1 writes a CPU profile of the first switch and prints its
// heaviest functions (self time).
//   NODE_PATH=<dir with playwright> node tests/view-switch-spike.cjs [fixture]
//   env: SWITCHES (default 4), OUT (profile path, default tests/view-switch.cpuprofile),
//        TRACE=<path>: a Chrome trace of the first switch, and its longest
//        main-thread events by name (style, layout, paint, GPU waits...)
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

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ channel: 'msedge', headless: false });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 300)));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html${process.env.QUERY ? '?' + process.env.QUERY : ''}`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const fixture = process.argv[2] || '1500.json';
    const t0 = Date.now();
    await page.evaluate(async fixture => {
        applyMainMenuSettingsSnapshot(await (await fetch('tests/' + fixture)).json());
        startSoloGame();
    }, fixture);
    await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 300000 });
    console.log(`match ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await page.evaluate(() => {
        window.__vs = { frames: [], tasks: [], last: performance.now() };
        const frame = now => { __vs.frames.push([now, now - __vs.last]); __vs.last = now; requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
        new PerformanceObserver(list => { for (const e of list.getEntries()) __vs.tasks.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false });
    });
    await page.waitForTimeout(3000);
    const cdp = await page.context().newCDPSession(page);
    const center = async id => page.evaluate(id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, id);
    const switches = Number(process.env.SWITCHES) || 4;
    const startMode = await page.evaluate(() => renderDimensionMode);
    for (let i = 0; i < switches; i++) {
        const to = (await page.evaluate(() => renderDimensionMode)) === '3d' ? '2d' : '3d';
        const profile = process.env.PROFILE && i === 0;
        const trace = process.env.TRACE && i === 0;
        if (trace) await browser.startTracing(page, { path: process.env.TRACE, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'gpu', 'v8.execute'] });
        if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
        const before = await page.evaluate(() => ({ at: performance.now(), tick: simClientStats().appliedTick }));
        const [x, y] = await center('btn-view-' + to);
        await page.mouse.click(x, y);
        await page.waitForTimeout(3000);
        const r = await page.evaluate(at => {
            const frames = __vs.frames.filter(f => f[0] >= at), tasks = __vs.tasks.filter(t => t[0] + t[1] >= at);
            return { maxFrame: Math.max(0, ...frames.map(f => f[1])), over50: frames.filter(f => f[1] > 50).length, maxTask: Math.max(0, ...tasks.map(t => t[1])), tick: simClientStats().appliedTick, mode: renderDimensionMode };
        }, before.at);
        console.log(`switch ${i + 1} -> ${to}${i < 2 ? ' (first)' : ''}: longest frame ${r.maxFrame.toFixed(0)} ms, frames over 50 ms ${r.over50}, longest task ${r.maxTask.toFixed(0)} ms, ticks in 3 s ${r.tick - before.tick}, now ${r.mode}`);
        if (trace) {
            await browser.stopTracing();
            const events = JSON.parse(fs.readFileSync(process.env.TRACE, 'utf8')).traceEvents || [];
            const main = events.find(e => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
            const byName = new Map();
            for (const e of events) if (e.ph === 'X' && e.dur > 5000 && (!main || (e.pid === main.pid && e.tid === main.tid))) {
                const k = e.name + (e.args && e.args.data && e.args.data.functionName ? ' ' + e.args.data.functionName : '');
                const v = byName.get(k) || { n: 0, max: 0, sum: 0 }; v.n++; v.max = Math.max(v.max, e.dur / 1000); v.sum += e.dur / 1000; byName.set(k, v);
            }
            console.log('  main-thread events over 5 ms (name: count, longest, total ms):');
            for (const [k, v] of [...byName].sort((a, b) => b[1].max - a[1].max).slice(0, 20)) console.log(`    ${k}: ${v.n}, ${v.max.toFixed(0)}, ${v.sum.toFixed(0)}`);
        }
        if (profile) {
            const { profile: p } = await cdp.send('Profiler.stop');
            const out = process.env.OUT || path.join(__dirname, 'view-switch.cpuprofile');
            fs.writeFileSync(out, JSON.stringify(p));
            const self = new Map(), dt = new Map();
            for (let k = 0; k < p.samples.length; k++) dt.set(p.samples[k], (dt.get(p.samples[k]) || 0) + (p.timeDeltas[k] || 0) / 1000);
            for (const n of p.nodes) {
                const f = n.callFrame, key = `${f.functionName || '(anon)'} ${path.basename(f.url || '')}:${f.lineNumber + 1}`;
                self.set(key, (self.get(key) || 0) + (dt.get(n.id) || 0));
            }
            console.log('  heaviest (self ms over the 3 s):');
            for (const [k, v] of [...self].filter(([k]) => !/\(idle\)|\(program\)|\(garbage/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`    ${v.toFixed(1).padStart(7)}  ${k}`);
        }
    }
    console.log('start mode', startMode, 'prewarmed', await page.evaluate(() => typeof _view3DPrewarmed !== 'undefined' && JSON.stringify({ units: _view3DPrewarmed && _view3DPrewarmed.units })), 'errors', errors.slice(0, 5));
    await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
