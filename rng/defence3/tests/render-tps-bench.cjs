// Rendering vs simulation rate in Microsoft Edge (FPS_TPS_STABILITY.md):
// the real page, the real simulation worker and helpers, the real GPU.
// For each workload (idle, moving, combat) and view (rendering off, 3D and
// 2D far, close, empty, tilted), after a warm-up: completed ticks per second
// (results the page applied, and the worker's own tick counter), the
// worker's time per tick, result latency, frame times (p50/p95/p99 of the
// page's animation frames), long tasks on the page, the JS heap.
// Run alone (never with tests or another benchmark).
//   NODE_PATH=<dir with playwright> node tests/render-tps-bench.cjs [fixture]
//   (default multiplayer: a host and a guest page; MP=0: one solo page, a test
//   bed only. Fixtures 50000-200 and 100000-1000, or FIXTURES=a,b; SIMHELPERS
//   per page in multiplayer, default 3)
//   env: CASE_S (seconds per case, default 15), WARM_S (warm-up, 10),
//        VIEWS (comma list), LOADS (comma list), VIS (map visibility modes:
//        full,team,history; default all three), HEADED=1, OUT (json path),
//        QUERY (page URL query, e.g. simahead=0), PROFILE_VIEW (a view whose
//        case is CPU-profiled on every page: <OUT>-<role>-<view>.cpuprofile)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CASE_S = Number(process.env.CASE_S) || 15, WARM_S = Number(process.env.WARM_S) || 10;
const VIEWS = (process.env.VIEWS || 'off,3d-far,2d-far,3d-close,2d-close,empty,tilted').split(',');
const LOADS = (process.env.LOADS || 'idle,moving,combat').split(',');
// Map visibility (menu: Full visibility, Team, Team + history): each costs
// differently on both sides (sight grids, fog history, what is drawn).
const VISES = (process.env.VIS || 'full,team,history').split(',');

// In the page: counters for a measured window.
const PAGE_SETUP = () => {
    const W = window.__bench = { frames: [], ticks: [], longTasks: 0, longMs: 0, on: false };
    const raf = ts => { if (W.on) W.frames.push(ts); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    try { new PerformanceObserver(list => { if (!W.on) return; for (const e of list.getEntries()) { W.longTasks++; W.longMs += e.duration; } }).observe({ type: 'longtask', buffered: false }); } catch { }
    const apply = _simClientApplyTick;
    _simClientApplyTick = function (msg) { if (W.on && msg && msg.epoch === _simClient.epoch) W.ticks.push([performance.now(), msg.tick, Number(msg.simMs) || 0]); return apply.apply(this, arguments); };
    W.render = processRenderFrame;
};
// The view: rendering off (no frame drawn: processRenderFrame does nothing),
// or a camera.
const PAGE_VIEW = view => {
    const W = window.__bench;
    processRenderFrame = view === 'off' ? function () { } : W.render;
    if (view === 'off') return { view };
    const is3d = view.startsWith('3d') || view === 'tilted';
    setRenderDimensionMode(is3d ? '3d' : '2d');
    const fit = Math.min(viewW / WORLD_W, viewH / WORLD_H);
    // Close views: where most units are (the median of a sample).
    const xs = [], ys = [];
    for (let i = 0; i < units.length; i += Math.max(1, Math.floor(units.length / 2000))) { const u = units[i]; if (u && !u.dead) { xs.push(u.x); ys.push(u.y); } }
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const cx = xs.length ? xs[xs.length >> 1] : WORLD_W / 2, cy = ys.length ? ys[ys.length >> 1] : WORLD_H / 2;
    let zoom = fit, x = WORLD_W / 2, y = WORLD_H / 2;
    if (view.endsWith('close')) { zoom = 1.5; x = cx; y = cy; }
    else if (view === 'empty') { zoom = 2; x = 64; y = 64; }
    else if (view === 'tilted') { zoom = 0.6; x = WORLD_W / 2; y = WORLD_H / 2; }
    camera.zoom = zoom; camera.x = x - viewW / zoom / 2; camera.y = y - viewH / zoom / 2;
    if (is3d && typeof renderer3dInstance !== 'undefined' && renderer3dInstance) renderer3dInstance.orbitPitch = view === 'tilted' ? 0.45 : view === '3d-far' ? 1.35 : 0.92;
    return { view, zoom: Math.round(zoom * 1000) / 1000, mode: renderDimensionMode };
};
// The workload: every combat unit of both teams (the local player's through
// its orders, the other team's processed as the same orders would be).
const PAGE_LOAD = load => {
    if (load === 'idle') return { load };
    const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType).map(u => u.id);
    const W = GRID_W * TILE, H = GRID_H * TILE;
    if (load === 'moving') {
        for (let i = 0; i < 10; i++) queueAction({ action: 'move', unitIds: mine.filter((u, k) => k % 10 === i), targetX: (0.15 + 0.7 * ((i * 7) % 10) / 9) * W, targetY: (0.15 + 0.7 * ((i * 3) % 10) / 9) * H });
    } else if (load === 'combat') {
        queueAction({ action: 'attackMove', unitIds: mine, targetX: W / 2, targetY: H / 2 });
    }
    return { load, ordered: mine.length };
};
const PAGE_COLLECT = () => {
    const W = window.__bench;
    W.on = false;
    const q = (a, p) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(b.length * p))] * 100) / 100; };
    const d = []; for (let i = 1; i < W.frames.length; i++) d.push(W.frames[i] - W.frames[i - 1]);
    const t = W.ticks, secs = t.length > 1 ? (t[t.length - 1][0] - t[0][0]) / 1000 : 0;
    const gaps = []; for (let i = 1; i < t.length; i++) gaps.push(t[i][0] - t[i - 1][0]);
    const sim = t.map(r => r[2]);
    const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
    return {
        appliedTps: secs > 0 ? Math.round((t.length - 1) / secs * 10) / 10 : 0,
        tickGapMs: { p50: q(gaps, .5), p95: q(gaps, .95), max: q(gaps, 1) },
        workerSimMs: { mean: sim.length ? Math.round(sim.reduce((a, b) => a + b, 0) / sim.length * 10) / 10 : 0, p95: q(sim, .95), max: q(sim, 1) },
        fps: d.length ? Math.round(d.length / (d.reduce((a, b) => a + b, 0) / 1000) * 10) / 10 : 0,
        frameMs: { p50: q(d, .5), p95: q(d, .95), p99: q(d, .99), max: q(d, 1) },
        longTasks: W.longTasks, longMs: Math.round(W.longMs), heapMB: mem, sim: simClientStats()
    };
};

let browser;
// The page URL: the query (QUERY) and, in multiplayer, helpers per page
// (two peers simulate the whole world on one machine: SIMHELPERS, default 3).
const pageUrl = (port, mp) => {
    const q = new URLSearchParams(process.env.QUERY || '');
    if (mp && !q.has('simhelpers')) q.set('simhelpers', process.env.SIMHELPERS || '3');
    const qs = q.toString();
    return `http://127.0.0.1:${port}/index.html${qs ? '?' + qs : ''}`;
};
const newPage = async (ctx, errors, role) => {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(role + ': ' + e.message.slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(role + ': ' + m.text().slice(0, 300)); });
    page.on('response', r => { if (r.status() >= 400) errors.push(role + ': ' + r.status() + ' ' + r.url().slice(0, 200)); });
    return page;
};
const VIEWPORT = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 };
// Solo (a test bed only): one page starts the fixture's match.
async function startSolo(browser, port, fixture, vis, errors) {
    const ctx = await browser.newContext(VIEWPORT);
    const page = await newPage(ctx, errors, 'solo');
    await page.goto(pageUrl(port, false), { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(1000);
    const setup = await page.evaluate(async ([fixture, vis]) => {
        const data = await (await fetch('tests/' + fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        document.getElementById('cfg-full-vis').value = vis;
        const now = Date.now; Date.now = () => 1790000000000;
        try { startSoloGame(); } finally { Date.now = now; }
        return { units: units.length, towers: towers.length, map: GRID_W, vis, fullVisibility, teamVisibilityHistory };
    }, [fixture, vis]);
    await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 300000 });
    return { ctxs: [ctx], pages: [['solo', page]], setup };
}
// Multiplayer (the game's real mode): a host page opens an online lobby with
// the fixture's settings, a guest page (its own browser context: one profile
// in two tabs is refused) joins it over loopback (PeerJS broker, WebRTC), the
// host starts the match.
async function startMultiplayer(browser, port, fixture, vis, errors) {
    const ctxH = await browser.newContext(VIEWPORT), ctxG = await browser.newContext(VIEWPORT);
    const host = await newPage(ctxH, errors, 'host'), guest = await newPage(ctxG, errors, 'guest');
    await Promise.all([host, guest].map(p => p.goto(pageUrl(port, true), { waitUntil: 'load', timeout: 120000 })));
    await host.waitForTimeout(1000);
    await host.evaluate(async ([fixture, vis]) => {
        const data = await (await fetch('tests/' + fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        document.getElementById('cfg-full-vis').value = vis;
        hostOnlineGame();
    }, [fixture, vis]);
    const hostId = await (await host.waitForFunction(() => isHost && typeof myPeerId === 'string' && myPeerId ? myPeerId : null, {}, { timeout: 60000 })).jsonValue();
    await guest.evaluate(id => joinGame(id), hostId);
    await host.waitForFunction(() => connections.length > 0 && lobbyPlayers.length >= 2, {}, { timeout: 60000 });
    await host.waitForTimeout(1500);
    await host.evaluate(() => startHostedGame());
    for (const p of [host, guest]) await p.waitForFunction(() => gameStarted && typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 400000 });
    const setup = await host.evaluate(vis => ({ units: units.length, towers: towers.length, map: GRID_W, vis, fullVisibility, teamVisibilityHistory, teams: activeTeamIds.length }), vis);
    return { ctxs: [ctxH, ctxG], pages: [['host', host], ['guest', guest]], setup };
}

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-precise-memory-info'] });
    const port = server.address().port, mp = process.env.MP !== '0';
    const errors = [];
    // Fixtures: FIXTURES (comma list) or the argument; rendering at scale.
    const fixtures = (process.env.FIXTURES || process.argv[2] || '50000-200.json,100000-1000.json').split(',').map(f => f.endsWith('.json') ? f : f + '.json');
    const out = { mode: mp ? 'multiplayer' : 'solo', fixtures, query: process.env.QUERY || '', caseS: CASE_S, warmS: WARM_S, rows: [], errors };
    for (const fixture of fixtures) for (const vis of VISES) for (const load of LOADS) {
        // A fresh match per workload: the same start.
        const m = mp ? await startMultiplayer(browser, port, fixture, vis, errors) : await startSolo(browser, port, fixture, vis, errors);
        const page0 = m.pages[0][1];
        if (!out.gpu) out.gpu = await page0.evaluate(() => { try { const c = document.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl'), e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { return null; } });
        const ordered = {};
        for (const [role, page] of m.pages) { await page.evaluate(PAGE_SETUP); ordered[role] = (await page.evaluate(PAGE_LOAD, load)).ordered; }
        for (const view of VIEWS) {
            const v = {};
            for (const [role, page] of m.pages) v[role] = await page.evaluate(PAGE_VIEW, view);
            await sleep(WARM_S * 1000);
            const w0 = {};
            for (const [role, page] of m.pages) {
                await page.evaluate(() => { const W = window.__bench; W.frames = []; W.ticks = []; W.longTasks = 0; W.longMs = 0; W.on = true; });
                w0[role] = Number(await page.evaluate(() => simClientRequest('debugEval', { expr: 'currentTick' })));
            }
            const profiling = process.env.PROFILE_VIEW === view ? [] : null;
            if (profiling) for (const [role, page] of m.pages) {
                const cdp = await page.context().newCDPSession(page);
                await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start');
                profiling.push([role, cdp]);
            }
            const a = Date.now();
            await sleep(CASE_S * 1000);
            if (profiling) for (const [role, cdp] of profiling) {
                const { profile } = await cdp.send('Profiler.stop');
                const base = (process.env.OUT || path.join(__dirname, 'render-tps-bench.json')).replace(/\.json$/, '');
                fs.writeFileSync(`${base}-${role}-${view}.cpuprofile`, JSON.stringify(profile));
            }
            for (const [role, page] of m.pages) {
                const w1 = Number(await page.evaluate(() => simClientRequest('debugEval', { expr: 'currentTick' })));
                const secs = (Date.now() - a) / 1000;
                const r = await page.evaluate(PAGE_COLLECT);
                const row = { fixture, role, vis, load, view, ...v[role], setup: m.setup, ordered: ordered[role], workerTps: Math.round((w1 - w0[role]) / secs * 10) / 10, ...r };
                if (row.sim) delete row.sim.errors;
                console.log(JSON.stringify({ fixture, role, vis, load, view, workerTps: row.workerTps, appliedTps: row.appliedTps, simMs: row.workerSimMs,
                    late: row.sim && row.sim.workerLateMs, ahead: row.sim && row.sim.dispatchAhead, fps: row.fps, frameMs: row.frameMs, longMs: row.longMs, heapMB: row.heapMB }));
                out.rows.push(row);
            }
        }
        for (const ctx of m.ctxs) await ctx.close();
    }
    const file = process.env.OUT || path.join(__dirname, 'render-tps-bench.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log('written', file, 'errors', errors.length ? errors.slice(0, 8) : 0);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
