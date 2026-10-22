// Selection thrash at scale in Microsoft Edge: the real page, the real
// simulation worker and helpers, the real GPU, the mouse driven as a player
// drives it. Per phase: frame times, tick gaps (results applied and the
// worker's own counter), the worker's time per tick, long tasks, input
// handler times, and which page / worker functions took longest in one call
// (the spikes, not the means). Run alone (never with tests or a benchmark).
//   NODE_PATH=<dir with playwright> node tests/selection-thrash-bench.cjs [fixture]
//   env: PHASES (comma list, default idle,selall,box,move,boxmove)
//          idle     nothing selected
//          selall   one box over the whole army, then held
//          box      RATE boxes a second: all, a tenth, another nine tenths...
//          shift    the same boxes with shift held (the selection only grows)
//          sub      the info panel's subgroup toggles clicked RATE a second
//          move     everything selected and ordered across the map, then held
//          boxmove  box over the moving army
//          groups   control groups stored and recalled RATE a second
//        SECS (per phase, 10), RATE (5), MODE (2d | 3d), VIS (full | team |
//        history), HEADED=1, OUT (json path), TAG (default 'run'),
//        PROFILE (a phase: CPU profiles of the page and every worker over it,
//        <OUT>-<phase>-page.cpuprofile, -w<k>-<name>.cpuprofile),
//        QUERY (page URL query), WARM_S (10)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm' };
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SECS = Number(process.env.SECS) || 10, RATE = Number(process.env.RATE) || 5, WARM_S = Number(process.env.WARM_S) || 10;
const PHASES = (process.env.PHASES || 'idle,selall,box,move,boxmove').split(',');
const MODE = process.env.MODE === '3d' ? '3d' : '2d', VIS = process.env.VIS || 'full';
const TAG = process.env.TAG || 'run';
const OUT = process.env.OUT || path.join(root, '.claude', `selbench-${TAG}.json`);
const fixture = (process.argv[2] || '300000-1000.json').replace(/^(?!.*\.json$)(.*)$/, '$1.json');

// Page functions timed per call (those that are globals there).
const PAGE_FNS = ['processRenderFrame', 'build3DFrameData', 'draw', 'drawMinimap', 'drawInteractionOverlay', 'flushTickUiRequests', 'updateHUD',
    'updateControlGroupBar', 'updateInfoPanel', 'updateBottomBar', 'updateBuildMenu', 'commitStaticCaches', '_simClientApplyTick', '_simClientApplyWorld',
    '_simClientApplyFrame', '_simClientPageTickWork', '_simClientWatch', '_simClientApplyDetails', 'processVisibleSimulationFrame', 'pumpSimulationTicks',
    'getSelectionMaskOverlay', 'getOrderMarkers', 'buildScaleOverlays', 'getActiveUnits', 'getActiveUnitClasses', 'getActiveUnitsForRender', 'getActiveEntities',
    'getChunkRenderView', '_unitDetailSplit', 'updateVisualVisibility', 'sampleGameStats', 'gameStatsStep', 'pageApplyStructures', 'pageApplyState',
    'pageApplyStructureDetails', 'getSelectionContours', 'get3DBoxSelection', 'queueAction', 'runOneTick', 'updateCamera', 'requestBuildMenuRefresh',
    'doesCurrentSelectionMatchSnapshot', 'toggleVisibleSameTypeSelectionFromHit', 'findNearestOwnedSelectableClickTarget', 'netMaintain', 'resyncAfterTick',
    'snapStoreTickHash', '_simClientReplayEvents', '_simClientUpdateStableSlots', '_simClientRebaseFrame', 'actionIdsEncode', 'sanitizeAction'];
const PAGE_SETUP = names => {
    const W = window.__sel = { frames: [], ticks: [], long: [], events: [], pres: [], fn: {}, slow: [], on: false };
    const raf = ts => { if (W.on) W.frames.push(ts); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    try { new PerformanceObserver(list => { if (W.on) for (const e of list.getEntries()) W.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false }); } catch { }
    // (Input handlers: from the event to the end of its handlers.)
    try { new PerformanceObserver(list => { if (W.on) for (const e of list.getEntries()) W.events.push([e.name, e.startTime, e.processingStart - e.startTime, e.processingEnd - e.processingStart, e.duration]); }).observe({ type: 'event', durationThreshold: 16, buffered: false }); } catch { }
    const time = (name, f, self) => function () {
        const a = performance.now();
        try { return f.apply(self || this, arguments); } finally {
            if (W.on) {
                const d = performance.now() - a, s = W.fn[name] || (W.fn[name] = { n: 0, ms: 0, max: 0 });
                s.n++; s.ms += d; if (d > s.max) s.max = d;
                if (d > 8 && W.slow.length < 4000) W.slow.push([name, Math.round(a), Math.round(d * 10) / 10]);
            }
        }
    };
    for (const name of names) { const f = window[name]; if (typeof f === 'function') window[name] = time(name, f); }
    if (typeof renderer3dInstance !== 'undefined' && renderer3dInstance) renderer3dInstance.render = time('renderer3d.render', renderer3dInstance.render, renderer3dInstance);
    const apply = _simClientApplyTick;
    _simClientApplyTick = function (msg) { if (W.on && msg && msg.epoch === _simClient.epoch) W.ticks.push([performance.now(), msg.tick, Number(msg.simMs) || 0, Number(msg.encodeMs) || 0, Number(msg.lateMs) || 0]); return apply.apply(this, arguments); };
    const onMsg = _simClientOnMessage;
    _simClientOnMessage = function (msg) { if (W.on && msg && msg.type === 'presentation') W.pres.push([performance.now(), msg.tick, Number(msg.buildMs) || 0]); return onMsg.apply(this, arguments); };
    return Object.keys(W.fn).length;
};
// The worker's parts of a tick, and what it does between ticks.
const WORKER_FNS = ['_simTick', '_simRequest', 'gameTick', 'processActions', '_simPostResult', 'snapRecordTickHash', 'resyncAfterTick',
    'updateAllPlayerVisibility', 'recalculateUnitEffectiveLevel', 'processGlobalSpawnerQueue', 'simMoveRun', 'simMoveEndTick', 'spatialIndexRebuild',
    'runUnitSeparationPass', '_forEachUnitInTickOrder', 'simUnitStateCollect', 'advanceGroupRoutes', 'takeDuePendingPathUnits', 'recomputePlayerPopCaps',
    '_runAdjacencyRecalculation', 'unitHitsResolve', 'statusPrepassRun', 'runQueuedOrders', 'navTick', 'navFieldsFlush', 'compactRemovedUnits',
    'ensureLaserConnections', 'gameStatsStep', 'healerCandidatesStep', 'simPresentationPublish', 'simPresentTickEnd', 'simFrameEncodeState', 'simFrameDetails',
    'simFrameStructureDetails', 'simFrameWatch', 'simFrameWatchStructures', 'simPresentationPump', 'workerSearchTierStep', 'towersTick', 'laserBeamsTick',
    'adjacencyLaneStep', '_acqTierStep', 'simParallelBackgroundWait', 'actionIdsDecode', 'sanitizeAction', 'issueMoveOrder', 'issueAttackMoveOrder'];
const workerSetup = page => page.evaluate(names => simClientRequest('debugEval', { expr: `(() => {
    if (self.__ph) return Object.keys(self.__ph.w).length;
    const P = self.__ph = { t: {}, c: {}, m: {}, w: {}, slow: [], n0: currentTick, on: false }, now = () => performance.now();
    for (const name of ${JSON.stringify(names)}) {
        let f; try { f = self.eval(name); } catch (e) { continue; }
        if (typeof f !== 'function') continue;
        P.w[name] = 1;
        self.__phw = function () { const a = now(); try { return f.apply(this, arguments); } finally { if (P.on) { const d = now() - a; P.t[name] = (P.t[name] || 0) + d; P.c[name] = (P.c[name] || 0) + 1; if (d > (P.m[name] || 0)) P.m[name] = d;
            if (d > 25 && name !== '_simTick' && name !== 'gameTick' && P.slow.length < 400) P.slow.push([name, currentTick, Math.round(d * 10) / 10]); } } };
        self.eval(name + ' = self.__phw');
    }
    return Object.keys(P.w).length; })()` }), WORKER_FNS);
const workerBegin = page => page.evaluate(() => simClientRequest('debugEval', { expr: '(() => { const P = self.__ph; P.t = {}; P.c = {}; P.m = {}; P.slow = []; P.n0 = currentTick; P.on = true; return 1; })()' }));
const workerEnd = async page => JSON.parse(await page.evaluate(() => simClientRequest('debugEval', { expr: '(() => { const P = self.__ph; P.on = false; return { t: P.t, c: P.c, m: P.m, slow: P.slow, n: currentTick - P.n0, units: units.length }; })()' })));

const PAGE_VIEW = mode => {
    setRenderDimensionMode(mode);
    const zoom = Math.min(viewW / WORLD_W, viewH / WORLD_H);
    camera.zoom = zoom; camera.x = WORLD_W / 2 - viewW / zoom / 2; camera.y = WORLD_H / 2 - viewH / zoom / 2;
    if (mode === '3d' && typeof renderer3dInstance !== 'undefined' && renderer3dInstance) renderer3dInstance.orbitPitch = 1.35;
    return { mode: renderDimensionMode, zoom };
};
// Where this player's army is on the screen (client coordinates), and the
// game area.
const PAGE_GEOM = () => {
    const el = document.getElementById('game-area'), r = el.getBoundingClientRect();
    const F = simClientCurrentUnitVis();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, mine = 0;
    if (F) for (let k = 0; k < F.count; k++) { const s = F.order[k]; if (F.owner[s] !== localPlayerId) continue; mine++; const x = F.x[s], y = F.y[s]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const toScreen = (wx, wy) => {
        if (renderDimensionMode === '3d' && renderer3dInstance && renderer3dInstance.projectWorldToScreen) { const p = renderer3dInstance.projectWorldToScreen(wx / TILE, 0, wy / TILE); if (p) return [p.x + r.left, p.y + r.top]; }
        return [(wx - camera.x) * camera.zoom + r.left, (wy - camera.y) * camera.zoom + r.top];
    };
    const c = [toScreen(x0, y0), toScreen(x1, y0), toScreen(x0, y1), toScreen(x1, y1)];
    const clampX = v => Math.max(r.left + 4, Math.min(r.right - 4, v)), clampY = v => Math.max(r.top + 4, Math.min(r.bottom - 4, v));
    return { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, mine,
        army: { x0: clampX(Math.min(...c.map(p => p[0])) - 6), y0: clampY(Math.min(...c.map(p => p[1])) - 6), x1: clampX(Math.max(...c.map(p => p[0])) + 6), y1: clampY(Math.max(...c.map(p => p[1])) + 6) },
        world: { x0, y0, x1, y1, w: WORLD_W, h: WORLD_H } };
};
const PAGE_COLLECT = () => {
    const W = window.__sel;
    W.on = false;
    const q = (a, p) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(b.length * p))] * 10) / 10; };
    const gaps = t => { const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]); return d; };
    const fd = gaps(W.frames), tg = gaps(W.ticks.map(r => r[0])), pg = gaps(W.pres.map(r => r[0]));
    const span = a => a.length > 1 ? (a[a.length - 1] - a[0]) / 1000 : 0;
    const sim = W.ticks.map(r => r[2]), late = W.ticks.map(r => r[4]);
    const fn = Object.entries(W.fn).map(([k, v]) => [k, v.n, Math.round(v.ms), Math.round(v.max * 10) / 10]).sort((a, b) => b[3] - a[3]);
    const out = {
        fps: fd.length ? Math.round(fd.length / span(W.frames) * 10) / 10 : 0,
        frameMs: { p50: q(fd, .5), p95: q(fd, .95), p99: q(fd, .99), max: q(fd, 1) },
        frameOver: { 33: fd.filter(d => d > 33).length, 50: fd.filter(d => d > 50).length, 100: fd.filter(d => d > 100).length, 250: fd.filter(d => d > 250).length },
        appliedTps: tg.length ? Math.round(tg.length / span(W.ticks.map(r => r[0])) * 10) / 10 : 0,
        tickGapMs: { p50: q(tg, .5), p95: q(tg, .95), p99: q(tg, .99), max: q(tg, 1) },
        tickGapOver: { 75: tg.filter(d => d > 75).length, 100: tg.filter(d => d > 100).length, 250: tg.filter(d => d > 250).length },
        workerSimMs: { mean: sim.length ? Math.round(sim.reduce((a, b) => a + b, 0) / sim.length * 10) / 10 : 0, p50: q(sim, .5), p95: q(sim, .95), p99: q(sim, .99), max: q(sim, 1) },
        workerLateMs: { p50: q(late, .5), p95: q(late, .95), max: q(late, 1) },
        presentGapMs: { n: pg.length, p50: q(pg, .5), p95: q(pg, .95), max: q(pg, 1) }, presentBuildMs: { p50: q(W.pres.map(r => r[2]), .5), max: q(W.pres.map(r => r[2]), 1) },
        longTasks: { n: W.long.length, ms: Math.round(W.long.reduce((a, r) => a + r[1], 0)), max: Math.round(Math.max(0, ...W.long.map(r => r[1]))) },
        events: W.events.slice().sort((a, b) => b[3] - a[3]).slice(0, 8).map(e => [e[0], Math.round(e[2]), Math.round(e[3]), Math.round(e[4])]),
        eventCount: W.events.length, eventHandlerMaxMs: Math.round(Math.max(0, ...W.events.map(e => e[3]))),
        fnByMax: fn.slice(0, 16), fnByTotal: fn.slice().sort((a, b) => b[2] - a[2]).slice(0, 12),
        selected: selectedUnits.length, selectedEntities: selectedEntities.length, panel: (() => { const p = document.getElementById('info-panel'); return p ? { nodes: p.getElementsByTagName('*').length, html: p.innerHTML.length } : null; })(), heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        sim: (() => { const s = simClientStats(); return { late: s.workerLateMs, ahead: s.dispatchAhead, workerAhead: s.workerAhead, inFlight: s.inFlight, applyMs: s.applyMs, latencyMs: s.latencyMs, errors: s.errors }; })()
    };
    return out;
};
const PAGE_BEGIN = () => { const W = window.__sel; W.frames = []; W.ticks = []; W.long = []; W.events = []; W.pres = []; W.fn = {}; W.slow = []; W.on = true; };

async function workersProfileStart(browser) {
    const cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await cdp.send('Target.getTargets');
    const pending = new Map();
    let id = 1;
    cdp.on('Target.receivedMessageFromTarget', e => { const m = JSON.parse(e.message); const p = pending.get(e.sessionId + ':' + m.id); if (p) { pending.delete(e.sessionId + ':' + m.id); p(m); } });
    const sendTo = (sessionId, method, params = {}) => new Promise(res => { const mid = id++; pending.set(sessionId + ':' + mid, res); cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: mid, method, params }) }); });
    const workers = [];
    for (const t of targetInfos.filter(t => t.type === 'worker')) {
        try {
            const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: false });
            await sendTo(sessionId, 'Profiler.enable'); await sendTo(sessionId, 'Profiler.setSamplingInterval', { interval: 500 }); await sendTo(sessionId, 'Profiler.start');
            workers.push({ sessionId, url: t.url });
        } catch (e) { console.log('worker profile: could not attach', t.url, e.message); }
    }
    return { cdp, sendTo, workers };
}
async function workersProfileStop(P, base) {
    let k = 0;
    for (const w of P.workers) {
        const m = await P.sendTo(w.sessionId, 'Profiler.stop');
        const name = (w.url.match(/([a-z_]+)\.js/) || [0, 'worker'])[1];
        if (m.result && m.result.profile) fs.writeFileSync(`${base}-w${k++}-${name}.cpuprofile`, JSON.stringify(m.result.profile));
    }
    await P.cdp.detach();
    return k;
}

let browser;
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-precise-memory-info'] });
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300)); });
    const q = process.env.QUERY ? '?' + process.env.QUERY : '';
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html${q}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(1000);
    const t0 = Date.now();
    const setup = await page.evaluate(async ([fixture, vis]) => {
        const data = await (await fetch('tests/' + fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        document.getElementById('cfg-full-vis').value = vis;
        const now = Date.now; Date.now = () => 1790000000000;
        try { startSoloGame(); } finally { Date.now = now; }
        return { towers: towers.length, map: GRID_W, vis, fullVisibility, isolated: window.crossOriginIsolated };
    }, [fixture, VIS]);
    await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 600000 });
    setup.startS = Math.round((Date.now() - t0) / 100) / 10;
    setup.gpu = await page.evaluate(() => { try { const c = document.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl'), e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { return null; } });
    setup.view = await page.evaluate(PAGE_VIEW, MODE);
    setup.timed = await page.evaluate(PAGE_SETUP, PAGE_FNS);
    setup.workerTimed = Number(await workerSetup(page));
    setup.helpers = await page.evaluate(() => simClientStats().helpers);
    await sleep(WARM_S * 1000);
    let geom = await page.evaluate(PAGE_GEOM);
    setup.mine = geom.mine; setup.units = await page.evaluate(() => units.length);
    console.log('SETUP', JSON.stringify(setup), 'army', JSON.stringify(geom.army));

    const drag = async (x0, y0, x1, y1, mod) => {
        if (mod) await page.keyboard.down(mod);
        await page.mouse.move(x0, y0); await page.mouse.down();
        await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2); await page.mouse.move(x1, y1);
        await page.mouse.up();
        if (mod) await page.keyboard.up(mod);
    };
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    // The k-th box of a thrash: all, a tenth (anywhere in the army), nine
    // tenths (from a random corner), and again.
    const boxOf = (k, A) => {
        const w = A.x1 - A.x0, h = A.y1 - A.y0, m = k % 3;
        if (m === 0) return [A.x0, A.y0, A.x1, A.y1];
        const f = m === 1 ? Math.sqrt(.1) : Math.sqrt(.9), bw = w * f, bh = h * f;
        const x = A.x0 + rnd() * (w - bw), y = A.y0 + rnd() * (h - bh);
        return [x, y, x + bw, y + bh];
    };
    const selectAll = async () => { geom = await page.evaluate(PAGE_GEOM); const A = geom.army; await drag(A.x0, A.y0, A.x1, A.y1); };
    const thrash = async (ms, mod) => {
        const start = Date.now(); let k = 0;
        geom = await page.evaluate(PAGE_GEOM);
        while (Date.now() - start < ms) {
            const at = start + k * 1000 / RATE, wait = at - Date.now();
            if (wait > 0) await sleep(wait);
            // (The army moves: where it is now, once a second.)
            if (k % RATE === 0 && k) geom = await page.evaluate(PAGE_GEOM);
            const b = boxOf(k++, geom.army);
            await drag(b[0], b[1], b[2], b[3], mod);
        }
        return k;
    };
    const actions = {
        idle: async ms => { await page.keyboard.press('Escape'); await sleep(ms); return 0; },
        selall: async ms => { await selectAll(); await sleep(ms); return 1; },
        box: ms => thrash(ms, null),
        shift: ms => thrash(ms, 'Shift'),
        move: async ms => {
            await selectAll();
            // (Across the map: the other corner of the game area.)
            const R = geom.rect, A = geom.army, ax = (A.x0 + A.x1) / 2, ay = (A.y0 + A.y1) / 2;
            const tx = ax < (R.left + R.right) / 2 ? R.right - 200 : R.left + 200, ty = ay < (R.top + R.bottom) / 2 ? R.bottom - 150 : R.top + 150;
            await page.mouse.click((ax + tx) / 2, (ay + ty) / 2, { button: 'right' });
            await sleep(ms); return 1;
        },
        boxmove: ms => thrash(ms, null),
        sub: async ms => {
            await selectAll(); await sleep(1500);
            const start = Date.now(); let k = 0;
            while (Date.now() - start < ms) {
                const n = await page.evaluate(k => { const els = [...document.querySelectorAll('#info-panel [data-subgroup], #info-panel .subgroup, #info-panel .sel-group, #info-panel [data-group-key]')]; if (!els.length) return 0; els[k % els.length].click(); return els.length; }, k);
                if (!n && !k) { console.log('sub: no subgroup controls found'); break; }
                k++; await sleep(1000 / RATE);
            }
            return k;
        },
        groups: async ms => {
            const start = Date.now(); let k = 0;
            geom = await page.evaluate(PAGE_GEOM);
            for (let g = 1; g <= 3; g++) { const b = boxOf(g, geom.army); await drag(b[0], b[1], b[2], b[3]); await page.keyboard.press('Control+' + g); }
            while (Date.now() - start < ms) { await page.keyboard.press(String(1 + k++ % 3)); await sleep(1000 / RATE); }
            return k;
        }
    };
    const out = { fixture, mode: MODE, vis: VIS, secs: SECS, rate: RATE, setup, phases: {}, errors };
    const base = OUT.replace(/\.json$/, '');
    for (const phase of PHASES) {
        if (!actions[phase]) { console.log('unknown phase', phase); continue; }
        const profiling = process.env.PROFILE === phase;
        let cdp = null, wprof = null;
        if (profiling) {
            cdp = await ctx.newCDPSession(page);
            await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start');
            wprof = await workersProfileStart(browser);
        }
        await workerBegin(page);
        const w0 = Number(await page.evaluate(() => simClientRequest('debugEval', { expr: 'currentTick' })));
        await page.evaluate(PAGE_BEGIN);
        const a = Date.now();
        const acts = await actions[phase](SECS * 1000);
        const secs = (Date.now() - a) / 1000;
        const r = await page.evaluate(PAGE_COLLECT);
        const slow = await page.evaluate(() => window.__sel.slow);
        const W = await workerEnd(page);
        if (profiling) {
            const { profile } = await cdp.send('Profiler.stop');
            fs.writeFileSync(`${base}-${phase}-page.cpuprofile`, JSON.stringify(profile));
            console.log('profiles: page +', await workersProfileStop(wprof, `${base}-${phase}`), 'workers');
        }
        const wk = Object.keys(W.t).map(k => [k, W.c[k], Math.round(W.t[k] / Math.max(1, W.n) * 100) / 100, Math.round(W.m[k] * 10) / 10]);
        r.workerTps = Math.round(W.n / secs * 10) / 10; r.actions = acts; r.secs = Math.round(secs * 10) / 10; r.unitsAtEnd = W.units;
        r.workerByMax = wk.slice().sort((a, b) => b[3] - a[3]).slice(0, 14); r.workerByMean = wk.slice().sort((a, b) => b[2] - a[2]).slice(0, 14);
        r.workerSlow = W.slow.slice(0, 60); r.pageSlow = slow.slice(0, 200);
        out.phases[phase] = r;
        console.log(`\n== ${phase} (${r.secs}s, ${acts} actions, ${r.selected} selected) ==`);
        console.log('  fps', r.fps, 'frame ms', JSON.stringify(r.frameMs), 'over', JSON.stringify(r.frameOver));
        console.log('  tps applied', r.appliedTps, 'worker', r.workerTps, 'tick gap', JSON.stringify(r.tickGapMs), 'over', JSON.stringify(r.tickGapOver));
        console.log('  worker sim ms', JSON.stringify(r.workerSimMs), 'late', JSON.stringify(r.workerLateMs), 'present gap', JSON.stringify(r.presentGapMs), 'build', JSON.stringify(r.presentBuildMs));
        console.log('  panel', JSON.stringify(r.panel), 'entities', r.selectedEntities);
        console.log('  long tasks', JSON.stringify(r.longTasks), 'input handlers', r.eventCount, 'max', r.eventHandlerMaxMs, 'ms', JSON.stringify(r.events.slice(0, 4)));
        console.log('  page by max [name, calls, total ms, max ms]:', r.fnByMax.slice(0, 10).map(x => `${x[0]} ${x[1]}/${x[2]}/${x[3]}`).join('  '));
        console.log('  page by total:', r.fnByTotal.slice(0, 8).map(x => `${x[0]} ${x[2]}`).join('  '));
        console.log('  worker by max [name, calls, ms/tick, max ms]:', r.workerByMax.slice(0, 10).map(x => `${x[0]} ${x[1]}/${x[2]}/${x[3]}`).join('  '));
        console.log('  worker by mean:', r.workerByMean.slice(0, 10).map(x => `${x[0]} ${x[2]}`).join('  '));
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
    console.log('\nwritten', OUT, 'errors', errors.length ? errors.slice(0, 8) : 0);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
