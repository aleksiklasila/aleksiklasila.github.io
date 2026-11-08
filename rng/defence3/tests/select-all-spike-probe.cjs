'use strict';
// A big selection's spike in real Edge: the scene, zoomed out, then rounds of
// "box over the whole field, right click (move), Escape" by real mouse input.
// Per round: frame gaps (rAF), long tasks, the info panel refresh's longest
// call, and the simulation ticks (?simtrace=1 phases) of the window, with the
// slowest tick and its neighbours.
//   node tests/select-all-spike-probe.cjs [scene.gz] [rounds=4]   (HEADED=1, OUT=file.json)
const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright, startServer, sleep } = require('./perf-fuzz/env.cjs');
const fixture = process.argv[2] || 'defence3-scene-2026-10-31T15-12-46-206Z.gz';
const rounds = Number(process.argv[3]) || 4;
const out = path.resolve(process.env.OUT || 'tests/test-runs/select-all-spike/run.json');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0; };
(async () => {
    const { server, base } = await startServer();
    let browser;
    try {
        browser = await loadPlaywright().chromium.launch({ channel: 'msedge', headless: !process.env.HEADED });
        const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        // (CONSOLE=1: the page's and its workers' console errors and warnings.)
        if (process.env.CONSOLE) { const log = (src, m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', src, m.type(), m.text().slice(0, 300)); }; page.on('console', m => log('page', m)); page.on('worker', w => { w.on('console', m => log(w.url().split('/').pop().slice(0, 40), m)); }); }
        await page.goto(base + '/index.html?simtrace=1' + (process.env.URLQ ? '&' + process.env.URLQ : ''), { waitUntil: 'load', timeout: 120000 });
        await page.evaluate(async f => { await restoreSoloGameSnapshot(await readSoloGameSnapshotFile(await (await fetch('tests/' + f)).blob())); }, fixture);
        await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 600000 });
        await sleep(6000);
        await page.evaluate(() => {
            const L = window.__sa = { frames: [], tasks: [], panel: [], label: '' };
            // (R3D: build3DFrameData's phases summed, renderer.js _r3dPhase; and which GPU the page has.)
            window.__r3dPhases = {};
            try { const gl = document.createElement('canvas').getContext('webgl2'); const x = gl && gl.getExtension('WEBGL_debug_renderer_info'); L.gpu = x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl ? gl.getParameter(gl.RENDERER) : 'none'; } catch (e) { L.gpu = String(e); }
            new PerformanceObserver(list => { for (const e of list.getEntries()) L.tasks.push({ t: e.startTime, ms: e.duration, label: L.label }); }).observe({ type: 'longtask', buffered: false });
            const up = window.updateInfoPanel;
            window.updateInfoPanel = function (...a) { const t = performance.now(); try { return up.apply(this, a); } finally { if (!a[0]) L.panel.push({ t, ms: performance.now() - t, label: L.label }); } };
            L.fn = {};
            for (const name of ['_ipsApply', 'infoPanelBackgroundStep', 'infoPanelUnitGroupsSnapshot', 'drawMinimap', 'build3DFrameData', 'updateBottomBar', 'updateHUD', 'applyUnitCommandTargets', 'issueOrders']) {
                const f = window[name]; if (typeof f !== 'function') continue;
                window[name] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { const d = performance.now() - t, k = L.label + '|' + name, o = L.fn[k] || (L.fn[k] = { n: 0, sum: 0, max: 0 }); o.n++; o.sum += d; if (d > o.max) o.max = d; } };
            }
            const pm = window._infoPackMsg;
            if (typeof pm === 'function') window._infoPackMsg = function (m) { if (m && m.type === 'out') (L.pack || (L.pack = [])).push({ label: L.label, ms: m.ms, ph: m.phases }); return pm.apply(this, arguments); };
            let last = 0;
            const loop = ts => { if (last) L.frames.push({ t: ts, gap: ts - last, label: L.label }); last = ts; requestAnimationFrame(loop); };
            requestAnimationFrame(loop);
        });
        const canvasBox = await page.evaluate(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
        // Zoomed out (real wheel input over the map).
        await page.mouse.move(canvasBox.x + canvasBox.w / 2, canvasBox.y + canvasBox.h / 2);
        // (NEAR=1: the restored camera, a near view.)
        if (!process.env.NEAR) for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, 400); await sleep(30); }
        await sleep(3000);
        const marks = [];
        const mark = async label => { const m = await page.evaluate(l => { __sa.label = l; return { label: l, t: performance.now(), applied: simClientStats().appliedTick, fills: typeof _unitsPageFills === 'number' ? _unitsPageFills : -1 }; }, label); marks.push(m); return m; };
        const windows = [];
        const cdp = process.env.PROF ? await page.context().newCDPSession(page) : null;
        if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
        // TRACE=1: a browser timeline over the rounds (what the native time in a long task is: style, layout, paint, GC).
        const tcdp = process.env.TRACE ? await page.context().newCDPSession(page) : null;
        if (tcdp) await tcdp.send('Tracing.start', { categories: 'devtools.timeline,v8,disabled-by-default-v8.gc,blink', transferMode: 'ReturnAsStream' });
        // PROF=file: a CPU profile of the page over the calm window (Playwright's CDP session).
        let pcdp = null;
        if (process.env.PROF && !process.env.PROF_ROUNDS) { pcdp = await page.context().newCDPSession(page); await pcdp.send('Profiler.enable'); await pcdp.send('Profiler.setSamplingInterval', { interval: 500 }); await pcdp.send('Profiler.start'); }
        await mark('calm'); await sleep(4000);
        // INSPECT=expr: the page's value of expr, printed after the calm window.
        if (process.env.INSPECT) console.log('inspect', await page.evaluate(e => { try { return JSON.stringify(eval(e)); } catch (err) { return String(err); } }, process.env.INSPECT));
        if (pcdp) { const { profile } = await pcdp.send('Profiler.stop'); fs.writeFileSync(process.env.PROF, JSON.stringify(profile)); console.log('profile', process.env.PROF); }
        windows.push('calm');
        // (PROF_ROUNDS=1: the profile over the rounds instead of the calm window.)
        // (WPROF=file: the simulation worker's CPU profile over the rounds.)
        let wcdp = null;
        if (process.env.WPROF) {
            // (A worker over the browser's session: Target.attachToTarget, messages routed to it.)
            const bs = await browser.newBrowserCDPSession();
            const ti = (await bs.send('Target.getTargets')).targetInfos.find(x => x.type === 'worker' && /sim_worker.js/.test(x.url));
            if (!ti) console.log('no sim worker');
            else {
                const { sessionId } = await bs.send('Target.attachToTarget', { targetId: ti.targetId, flatten: false });
                let seq = 0; const wait = new Map();
                bs.on('Target.receivedMessageFromTarget', e => { if (e.sessionId !== sessionId) return; const m = JSON.parse(e.message); if (m.id && wait.has(m.id)) { wait.get(m.id)(m.result); wait.delete(m.id); } });
                const send = (method, params = {}) => new Promise(r => { const id = ++seq; wait.set(id, r); bs.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }); });
                wcdp = { send };
                await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 }); await send('Profiler.start');
            }
        }
        if (process.env.PROF && process.env.PROF_ROUNDS) { pcdp = await page.context().newCDPSession(page); await pcdp.send('Profiler.enable'); await pcdp.send('Profiler.setSamplingInterval', { interval: 500 }); await pcdp.send('Profiler.start'); }
        for (let r = 0; r < rounds; r++) {
            const lab = 'round' + r;
            await mark(lab + ':select');
            const x0 = canvasBox.x + 40, y0 = canvasBox.y + 40, x1 = canvasBox.x + canvasBox.w - 340, y1 = canvasBox.y + canvasBox.h - 140;
            await page.mouse.move(x0, y0); await page.mouse.down();
            for (let s = 1; s <= 8; s++) { await page.mouse.move(x0 + (x1 - x0) * s / 8, y0 + (y1 - y0) * s / 8); await sleep(16); }
            await page.mouse.up();
            await sleep(2500);
            await mark(lab + ':order');
            // (Odd rounds: an attack move, z then the right click.)
            if (r % 2 === 1 || process.env.ATTACK) await page.keyboard.press('z');
            await page.mouse.click(canvasBox.x + canvasBox.w * (0.3 + 0.1 * r), canvasBox.y + canvasBox.h * 0.5, { button: 'right' });
            await sleep(Number(process.env.ORDER_MS) || 3500);
            console.log(lab, 'panel', JSON.stringify(await page.evaluate(() => { const p = document.getElementById('info-panel'); window.__panelHtml = [...p.children].slice(0, 6).map(c => c.outerHTML); return { chars: p.innerHTML.length, nodes: p.getElementsByTagName('*').length, sections: p.children.length, sel: selectedUnits.length + '+' + selectedEntities.length, groups: Object.keys(_infoPanelEntityGroups()).length, pending: typeof _infoPanelPendingSections !== 'undefined' ? _infoPanelPendingSections : null, pack: typeof _ipk !== 'undefined' ? { state: _ipk.state, bins: _ipk.n, ms: +(_ipk.ms || 0).toFixed(2), seq: _ipk.seq, got: _ipk.binsSeq } : null }; })));
            await mark(lab + ':clear');
            await page.keyboard.press('Escape');
            await sleep(2500);
            windows.push(lab + ':select', lab + ':order', lab + ':clear');
        }
        if (pcdp && process.env.PROF_ROUNDS) { const { profile } = await pcdp.send('Profiler.stop'); fs.writeFileSync(process.env.PROF, JSON.stringify(profile)); console.log('profile', process.env.PROF); }
        if (wcdp) { const { profile } = await wcdp.send('Profiler.stop'); fs.writeFileSync(process.env.WPROF, JSON.stringify(profile)); console.log('worker profile', process.env.WPROF); }
        await mark('end');
        if (tcdp) {
            const done = new Promise(r => tcdp.once('Tracing.tracingComplete', r));
            await tcdp.send('Tracing.end');
            const { stream } = await done;
            let t = ''; for (;;) { const c = await tcdp.send('IO.read', { handle: stream }); t += c.data; if (c.eof) break; }
            fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out + '.trace.json', t);
        }
        if (cdp) { const { profile } = await cdp.send('Profiler.stop'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out + '.page.cpuprofile', JSON.stringify(profile)); }
        console.log('gpu', await page.evaluate(() => __sa.gpu));
        console.log('build3DFrameData phases (ms, all frames)', await page.evaluate(() => JSON.stringify(Object.entries(window.__r3dPhases || {}).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Math.round(v)]))));
        const data = await page.evaluate(() => ({ panelHtml: window.__panelHtml, sa: __sa, trace: __simTrace || [], units: units.length, sel: selectedUnits.length }));
        data.errors = errors; data.fixture = fixture; data.marks = marks;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify(data));
        // Ticks by window: the trace rows carry no page time, so they are split by the tick at each mark (in order).
        const summary = [];
        for (const w of windows) {
            const fr = data.sa.frames.filter(f => f.label === w).map(f => f.gap);
            const tasks = data.sa.tasks.filter(t => t.label === w).map(t => t.ms);
            const panel = data.sa.panel.filter(p => p.label === w).map(p => p.ms);
            summary.push({ w, frames: fr.length, gapP50: +pct(fr, .5).toFixed(1), gapP95: +pct(fr, .95).toFixed(1), gapMax: +Math.max(0, ...fr).toFixed(0),
                over50: fr.filter(g => g > 50).length, tps: (() => { const i = marks.findIndex(m => m.label === w); const a = marks[i], b = marks[i + 1]; return b ? +((b.applied - a.applied) * 1000 / (b.t - a.t)).toFixed(1) : null; })(), longTaskMax: +Math.max(0, ...tasks).toFixed(0), panelMax: +Math.max(0, ...panel).toFixed(1), panelCalls: panel.length });
        }
        console.log('units list fills per window', marks.map((m, i) => marks[i + 1] ? m.label + ':' + (marks[i + 1].fills - m.fills) : '').filter(Boolean).join(' '));
        console.table(summary);
        const fnRows = Object.entries(data.sa.fn).filter(([, o]) => o.max > 8).map(([k, o]) => ({ k, n: o.n, sum: +o.sum.toFixed(0), max: +o.max.toFixed(1) }));
        console.table(fnRows);
        const T = data.trace, tot = T.map(r => r.total);
        console.log('ticks', T.length, 'tick ms p50', pct(tot, .5).toFixed(1), 'p95', pct(tot, .95).toFixed(1), 'p99', pct(tot, .99).toFixed(1), 'max', Math.max(...tot).toFixed(1), 'slow (>1.5x median)', tot.filter(v => v > 1.5 * pct(tot, .5)).length);
        const idx = [...T.keys()].sort((a, b) => T[b].total - T[a].total).slice(0, 5);
        const top = ph => Object.entries(ph).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([k, v]) => k + ' ' + v.toFixed(1)).join(', ');
        for (const i of idx) for (const j of [i - 1, i, i + 1]) if (T[j]) console.log((j === i ? '>> ' : '   ') + 'tick ' + T[j].tick + ' total ' + T[j].total.toFixed(1) + ' gap ' + T[j].gap.toFixed(1) + ' | ' + top(T[j].ph));
        console.log('units', data.units, 'errors', errors.slice(0, 5), 'raw', out);
    } finally { if (browser) await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
