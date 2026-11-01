'use strict';
// What the combat effects cost the frame rate, in real Edge: the same scene
// and camera with the effect pass on, off, on again (A/B/A), in each view;
// frame gaps (rAF), the page's render-frame time and buildFrameEffects' own.
//   node tests/fx-ab-probe.cjs [scene.gz] [seconds a window=12]   (OUT=file.json, VIEWS=2d,3d)
const fs = require('node:fs'), path = require('node:path');
const { loadPlaywright, startServer, sleep } = require('./perf-fuzz/env.cjs');
const fixture = process.argv[2] || 'scenes/chaos-1m-250k.gz', secs = Number(process.argv[3]) || 12;
const out = path.resolve(process.env.OUT || 'tests/test-runs/fx-ab/run.json');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
(async () => {
    const { server, base } = await startServer();
    const browser = await loadPlaywright().chromium.launch({ channel: 'msedge', headless: !!process.env.HEADLESS });
    const rows = [];
    try {
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 120000 });
        await page.evaluate(async f => { await restoreSoloGameSnapshot(await readSoloGameSnapshotFile(await (await fetch('tests/' + f)).blob())); }, fixture);
        await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 600000 });
        await page.evaluate(() => {
            const L = window.__ab = { frames: [], fx: [], render: [], on: true, label: '' };
            const fx = window.buildFrameEffects, prf = window.processRenderFrame;
            window.buildFrameEffects = function () { if (!L.on) return; const t = performance.now(); try { return fx.apply(this, arguments); } finally { L.fx.push({ l: L.label, ms: performance.now() - t }); } };
            if (typeof prf === 'function') window.processRenderFrame = function () { const t = performance.now(); try { return prf.apply(this, arguments); } finally { L.render.push({ l: L.label, ms: performance.now() - t }); } };
            let last = 0;
            const loop = ts => { if (last) L.frames.push({ l: L.label, gap: ts - last }); last = ts; requestAnimationFrame(loop); };
            requestAnimationFrame(loop);
        });
        const box = await page.evaluate(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
        await page.mouse.move(box.x, box.y);
        for (const view of (process.env.VIEWS || '2d,3d').split(',')) {
            await page.evaluate(v => setRenderDimensionMode(v), view);
            await sleep(3000);
            for (const [i, on] of [[0, true], [1, false], [2, true], [3, false]]) {
                const label = `${view}:${i}:${on ? 'on' : 'off'}`;
                await page.evaluate(([l, o]) => { __ab.label = l; __ab.on = o; }, [label, on]);
                await sleep(secs * 1000);
                const r = await page.evaluate(l => {
                    const f = __ab.frames.filter(x => x.l === l).map(x => x.gap), fx = __ab.fx.filter(x => x.l === l).map(x => x.ms), rr = __ab.render.filter(x => x.l === l).map(x => x.ms);
                    return { f, fx, rr, tps: simClientStats().appliedTick, units: units.length };
                }, label);
                const sum = a => a.reduce((s, v) => s + v, 0);
                const row = { label, frames: r.f.length, fps: +(r.f.length / (sum(r.f) / 1000)).toFixed(1), gapP50: +pct(r.f, .5).toFixed(1), gapP95: +pct(r.f, .95).toFixed(1), gapMax: +Math.max(0, ...r.f).toFixed(0),
                    renderP50: +pct(r.rr, .5).toFixed(2), renderP95: +pct(r.rr, .95).toFixed(2), fxP50: +pct(r.fx, .5).toFixed(2), fxP95: +pct(r.fx, .95).toFixed(2), fxMax: +Math.max(0, ...r.fx).toFixed(1), units: r.units };
                rows.push(row); console.log(JSON.stringify(row));
            }
        }
    } finally { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(rows)); await browser.close(); server.close(); }
    console.table(rows);
})().catch(e => { console.error(e); process.exitCode = 1; });
