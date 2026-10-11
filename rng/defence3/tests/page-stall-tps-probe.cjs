// What a stalled page costs the match's tick rate, on every peer, in
// Microsoft Edge: the real pages, simulation workers and WebRTC link of a
// host and a guest. A page's main thread is held busy for a given time (as
// a long selection, a panel rebuild or a collection would hold it), and each
// peer's simulation worker tells when it finished each tick: the longest gap
// between two ticks around the stall, and how many ticks short of the pace
// the peer ended up.
// A stall should cost nobody a tick: not the other peers, not the stalled
// page's own simulation (its ticks run in its worker).
// Run alone (never with tests or another benchmark).
//   NODE_PATH=<dir with playwright> node tests/page-stall-tps-probe.cjs [fixture]
//   env: STALLS (ms list, default 120,250,500,1000), ROLES (host,guest),
//        BURST=n (n stalls of BURST_MS, BURST_GAP ms apart: a player clicking
//        about), WARM_S (10), QUERY (page URL query), OUT (json path),
//        GATE=1 (exit 1 when a stall costs any peer more than GATE_TICKS, 1)
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
const STALLS = (process.env.STALLS || '120,250,500,1000').split(',').map(Number).filter(n => n > 0);
const ROLES = (process.env.ROLES || 'host,guest').split(',');
const WARM_S = Number(process.env.WARM_S) || 10;
const BURST = Number(process.env.BURST) || 0, BURST_MS = Number(process.env.BURST_MS) || 120, BURST_GAP = Number(process.env.BURST_GAP) || 80;

// In the page: when its simulation worker finished each tick (the worker's
// own clock, as absolute time: results the page applies late still tell).
const PAGE_SETUP = () => {
    const W = window.__stall = { ticks: [] };
    const apply = _simClientApplyTick;
    _simClientApplyTick = function (msg) { if (msg && msg.epoch === _simClient.epoch) W.ticks.push([msg.tick, Number(msg.doneAt) || 0, Number(msg.lateMs) || 0, Number(msg.simMs) || 0]); return apply.apply(this, arguments); };
};
const pageUrl = port => {
    const q = new URLSearchParams(process.env.QUERY || '');
    if (!q.has('simhelpers')) q.set('simhelpers', process.env.SIMHELPERS || '3');
    return `http://127.0.0.1:${port}/index.html?${q}`;
};
const VIEWPORT = { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 };
async function startMultiplayer(browser, port, fixture, errors) {
    const ctxH = await browser.newContext(VIEWPORT), ctxG = await browser.newContext(VIEWPORT);
    const mk = async (ctx, role) => {
        const page = await ctx.newPage();
        page.on('pageerror', e => errors.push(role + ': ' + e.message.slice(0, 300)));
        page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(role + ': ' + m.text().slice(0, 300)); });
        return page;
    };
    const host = await mk(ctxH, 'host'), guest = await mk(ctxG, 'guest');
    await Promise.all([host, guest].map(p => p.goto(pageUrl(port), { waitUntil: 'load', timeout: 120000 })));
    await host.waitForTimeout(1000);
    await host.evaluate(async fixture => {
        const data = await (await fetch('tests/' + fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        hostOnlineGame();
    }, fixture);
    const hostId = await (await host.waitForFunction(() => isHost && typeof myPeerId === 'string' && myPeerId ? myPeerId : null, {}, { timeout: 60000 })).jsonValue();
    await guest.evaluate(id => joinGame(id), hostId);
    await host.waitForFunction(() => connections.length > 0 && lobbyPlayers.length >= 2, {}, { timeout: 60000 });
    await host.waitForTimeout(1500);
    await host.evaluate(() => startHostedGame());
    for (const p of [host, guest]) await p.waitForFunction(() => gameStarted && typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 400000 });
    const setup = await host.evaluate(() => ({ units: units.length, map: GRID_W, shared: !!(_simClient && _simClient.ctl), tickMs: TICK_MS }));
    return { ctxs: [ctxH, ctxG], pages: { host, guest }, setup };
}

// A peer's ticks around a stall that began at t0 and held for `ms`: the
// longest gap between two ticks' ends from the stall's start to a second
// after its end, and how many ticks short of the pace it is at the end of
// that window (against the pace of the two seconds before).
function measure(ticks, t0, ms, tickMs) {
    const before = ticks.filter(r => r[1] >= t0 - 2000 && r[1] < t0), a = t0, b = t0 + ms + 1000;
    const during = ticks.filter(r => r[1] >= a - tickMs * 1.5 && r[1] <= b);
    let maxGap = 0;
    for (let i = 1; i < during.length; i++) maxGap = Math.max(maxGap, during[i][1] - during[i - 1][1]);
    if (during.length) maxGap = Math.max(maxGap, Math.min(b, ticks.length ? ticks[ticks.length - 1][1] : b) - during[during.length - 1][1] - tickMs);
    const pace = before.length > 1 ? (before[before.length - 1][1] - before[0][1]) / (before.length - 1) : tickMs;
    const inWindow = ticks.filter(r => r[1] >= a && r[1] <= b).length;
    const expected = (b - a) / pace;
    return { maxGapMs: Math.round(maxGap), ticks: inWindow, expected: Math.round(expected * 10) / 10, lostTicks: Math.round((expected - inWindow) * 10) / 10, paceMs: Math.round(pace * 10) / 10,
        lateMs: Math.round(Math.max(0, ...during.map(r => r[2]))) };
}

let browser;
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const port = server.address().port, errors = [];
    const fixture = (process.argv[2] || '10000-160.json').replace(/(\.json)?$/, '.json');
    const m = await startMultiplayer(browser, port, fixture, errors);
    for (const p of Object.values(m.pages)) await p.evaluate(PAGE_SETUP);
    console.log('match', JSON.stringify(m.setup));
    await sleep(WARM_S * 1000);
    const out = { fixture, query: process.env.QUERY || '', setup: m.setup, rows: [], errors };
    const cases = [];
    for (const role of ROLES) for (const ms of STALLS) cases.push({ role, ms, n: 1, gap: 0 });
    if (BURST) for (const role of ROLES) cases.push({ role, ms: BURST_MS, n: BURST, gap: BURST_GAP });
    let worst = 0;
    for (const c of cases) {
        await sleep(2500);
        // The stall: the page's main thread busy (nothing else of it runs).
        const t0 = await m.pages[c.role].evaluate(async ([ms, n, gap]) => {
            const start = performance.timeOrigin + performance.now();
            for (let i = 0; i < n; i++) {
                const e = performance.now() + ms;
                while (performance.now() < e) { }
                if (i + 1 < n) await new Promise(r => setTimeout(r, gap));
            }
            return start;
        }, [c.ms, c.n, c.gap]);
        const total = c.n * c.ms + (c.n - 1) * c.gap;
        await sleep(2500);
        const row = { stalled: c.role, stallMs: c.ms, times: c.n, totalMs: total };
        for (const [role, page] of Object.entries(m.pages)) {
            const ticks = await page.evaluate(() => window.__stall.ticks.slice(-400));
            row[role] = measure(ticks, t0, total, m.setup.tickMs);
            worst = Math.max(worst, row[role].lostTicks);
        }
        out.rows.push(row);
        console.log(`${c.role} page stalled ${c.n > 1 ? c.n + ' x ' : ''}${c.ms} ms:`, Object.keys(m.pages).map(r => `${r} longest tick gap ${row[r].maxGapMs} ms, ${row[r].lostTicks} ticks lost (${row[r].ticks} of ${row[r].expected})`).join('; '));
    }
    for (const [role, page] of Object.entries(m.pages)) out[role] = await page.evaluate(() => ({ net: { lateSeals: netCounters.lateSeals || 0, autoTicks: netCounters.autoTicks || 0, desyncs: netCounters.desyncsDetected, patches: netCounters.patches + netCounters.fullPatches, hard: netCounters.hardResyncs }, sim: simClientStats() }));
    for (const role of Object.keys(m.pages)) if (out[role].sim) delete out[role].sim.errors;
    console.log('net', JSON.stringify({ host: out.host.net, guest: out.guest.net }));
    for (const ctx of m.ctxs) await ctx.close();
    const file = process.env.OUT || path.join(__dirname, 'page-stall-tps-probe.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log('written', file, 'errors', errors.length ? errors.slice(0, 8) : 0);
    if (process.env.GATE) {
        const limit = Number(process.env.GATE_TICKS) || 1;
        if (worst > limit) { console.error(`page-stall-tps-probe: a stall cost ${worst} ticks (limit ${limit})`); process.exitCode = 1; }
        if (out.host.net.desyncs || out.guest.net.desyncs) { console.error('page-stall-tps-probe: desyncs'); process.exitCode = 1; }
    }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
