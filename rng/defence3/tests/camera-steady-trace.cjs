'use strict';
// Focused real-browser trace of the supplied scene, with real held WASD input.
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, startServer, sleep } = require('./perf-fuzz/env.cjs');
const out = path.resolve(process.env.OUT || 'tests/test-runs/camera-steady-20261031/before.json');
const fixture = process.argv[2] || 'defence3-scene-2026-10-31T13-31-34-674Z.gz';
(async () => {
    const { server, base } = await startServer();
    let browser;
    try {
        browser = await loadPlaywright().chromium.launch({ channel: 'msedge', headless: !process.env.HEADED });
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        const cdp = await page.context().newCDPSession(page);
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(base + '/index.html', { waitUntil: 'load', timeout: 120000 });
        console.log('Restoring ' + fixture);
        await page.evaluate(async fixture => {
            await restoreSoloGameSnapshot(await readSoloGameSnapshotFile(await (await fetch('tests/' + fixture)).blob()));
        }, fixture);
        if (process.env.EXTRA_CSS) await page.addStyleTag({ content: process.env.EXTRA_CSS });
        await sleep(5000);
        console.log('Scene restored; collecting held-key camera trace');
        await page.evaluate(() => {
            const L = window.__cameraTrace = { frames: [], tasks: [], label: '', last: null, phases: {}, config: {
                camera: { ...camera }, speed: cameraPanSpeedMultiplier, mode: renderDimensionMode,
                pad: getRenderViewPad(), renderMaxHeight, cameraSlideEnabled, pixelSnapCamera,
                units: units.length, structures: typeof _pageTables !== 'undefined' ? _pageTables.s?.n : null
            } };
            new PerformanceObserver(list => { for (const e of list.getEntries()) L.tasks.push({ t: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: false });
            for (const name of ['build3DFrameData','drawMinimap','drawInteractionOverlay','updateHUD','updateBottomBar','_refreshInfoPanelPeriodic','updateCameraSlide']) {
                const original = window[name];
                if (typeof original !== 'function') continue;
                window[name] = function (...args) { const t = performance.now(); try { return original.apply(this, args); } finally { L.phases[name] = (L.phases[name] || 0) + performance.now() - t; } };
            }
            const draw = renderer3dInstance.render;
            renderer3dInstance.render = function (...args) { const t = performance.now(); try { return draw.apply(this, args); } finally { L.phases.gpuSubmit = performance.now() - t; } };
            const run = _runLoopFrame;
            _runLoopFrame = function (ts, next) {
                const start = performance.now(), prev = L.last, slide = _cameraSlideLast;
                const matrix = new DOMMatrix(getComputedStyle(renderer3dHost).transform);
                const animTime = _cameraSlideAnims[0]?.currentTime;
                L.phases = {};
                const r = run.apply(this, arguments);
                const cur = { x: camera.x, y: camera.y, zoom: camera.zoom };
                const row = { ts, start, ms: performance.now() - start, label: L.label, cam: cur, phases: { ...L.phases },
                    slide: slide ? { frame: slide.frameTime, duration: slide.durMs, elapsed: start - slide.frameTime,
                        currentTime: animTime, tx: matrix.m41, ty: matrix.m42 } : null,
                    velocity: { ..._cameraPanVel }, target: { ..._cameraPanTarget },
                    newSlide: _cameraSlideLast ? { frame: _cameraSlideLast.frameTime, duration: _cameraSlideLast.durMs } : null };
                if (prev) { row.gap = ts - prev.ts; row.step = { x: (cur.x - prev.cam.x) * cur.zoom, y: (cur.y - prev.cam.y) * cur.zoom }; }
                L.frames.push(row); L.last = row;
                return r;
            };
        });
        fs.mkdirSync(path.dirname(out), { recursive: true });
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
        await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,disabled-by-default-v8.gc,disabled-by-default-devtools.timeline', transferMode: 'ReturnAsStream' });
        for (const [label, keys, ms] of [["up","w",3000],["down","s",3000],["up","w",3000],["down","s",3000]]) {
            await page.evaluate(label => { __cameraTrace.label = label; }, label);
            for (const k of keys) await page.keyboard.down(k);
            await sleep(ms);
            for (const k of keys) await page.keyboard.up(k);
            await sleep(250);
        }
        const { profile } = await cdp.send('Profiler.stop');
        fs.writeFileSync(out + '.cpuprofile', JSON.stringify(profile));
        const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
        await cdp.send('Tracing.end');
        const { stream } = await complete;
        let trace = '';
        while (true) { const chunk = await cdp.send('IO.read', { handle: stream }); trace += chunk.data; if (chunk.eof) break; }
        await cdp.send('IO.close', { handle: stream });
        fs.writeFileSync(out + '.trace.json', trace);
        const data = await page.evaluate(() => __cameraTrace);
        data.errors = errors;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(data));
        const pct = (a,p) => a.sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))];
        const frames = data.frames;
        console.log(JSON.stringify({ out, config: data.config, frames: frames.length, errors,
            gap: { p50:pct(frames.map(x=>x.gap||0),.5),p95:pct(frames.map(x=>x.gap||0),.95),max:Math.max(...frames.map(x=>x.gap||0)) },
            render: { p95:pct(frames.map(x=>x.ms),.95),max:Math.max(...frames.map(x=>x.ms)) },
            exhausted:frames.filter(x=>x.slide&&x.slide.elapsed>x.slide.duration).length,
            slow:frames.filter(x=>x.gap>30||x.ms>30).slice(0,3),tasks:data.tasks.length }, null, 2));
    } finally { if (browser) await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
