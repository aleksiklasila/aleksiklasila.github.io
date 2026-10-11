// What a stalled page costs the match's tick rate, on every peer, in
// Microsoft Edge: the real pages, simulation workers and WebRTC link of a
// host and a guest. A page's main thread is held busy for a given time (as
// a long selection, a panel rebuild or a collection would hold it), and each
// peer's simulation worker tells when it finished each tick: the longest gap
// between two ticks around the stall, and how many ticks short of the pace
// the peer ended up.
// A stall should cost nobody a tick: not the other peers, not the stalled
// page's own simulation (its ticks run in its worker; sim_worker.js
// _simAutoStep). Orders given around a stall still run: the stalled page
// gives one right before it stalls, the other page one while it is stalled,
// and both sets of units are on their way afterwards. At the end the peers'
// states are compared (the lockstep hash of the same tick).
// Run alone (never with tests or another benchmark).
//   NODE_PATH=<dir with playwright> node tests/page-stall-tps-probe.cjs [fixture]
//   env: STALLS (ms list, default 120,250,500,1000), ROLES (host,guest),
//        BURST=n (n stalls of BURST_MS, BURST_GAP ms apart: a player clicking
//        about), MP=0 (one page alone), WARM_S (10), QUERY (page URL query,
//        e.g. simauto=0: the worker takes no tick by itself), OUT (json path),
//        GATE=1 (exit 1 when a stall costs any peer more than GATE_TICKS, 1.5,
//        an order did not run, or the peers' states differ)
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
const MP = process.env.MP !== '0';
const STALLS = (process.env.STALLS || '120,250,500,1000').split(',').map(Number).filter(n => n > 0);
const ROLES = MP ? (process.env.ROLES || 'host,guest').split(',') : ['solo'];
const WARM_S = Number(process.env.WARM_S) || 10;
const BURST = Number(process.env.BURST) || 0, BURST_MS = Number(process.env.BURST_MS) || 120, BURST_GAP = Number(process.env.BURST_GAP) || 80;

// In the page: when its simulation worker finished each tick (the worker's
// own clock, as absolute time: results the page applies late still tell).
const PAGE_SETUP = () => {
    const W = window.__stall = { ticks: [], orders: 0, auto: [] };
    const adopt = lockstepAdoptAutoTick;
    lockstepAdoptAutoTick = function (tick) { W.auto.push(tick); return adopt.apply(this, arguments); };
    const apply = _simClientApplyTick;
    _simClientApplyTick = function (msg) { if (msg && msg.epoch === _simClient.epoch) W.ticks.push([msg.tick, Number(msg.doneAt) || 0, Number(msg.lateMs) || 0, Number(msg.simMs) || 0]); return apply.apply(this, arguments); };
    // An order to units of this player no order of this run went to yet: to a
    // point far from where they stand. Returns them and the point.
    W.used = new Set();
    W.order = () => {
        const ids = [];
        for (const u of units) { if (ids.length >= 40) break; if (u && !u.dead && u.owner === localPlayerId && !u.workerType && !W.used.has(u.id)) { ids.push(u.id); W.used.add(u.id); } }
        W.orders++;
        if (!ids.length) return null;
        // (A point of its own for each order: the simulation is asked
        // afterwards whether these units are on their way to it.)
        const wx = GRID_W * TILE, wy = GRID_H * TILE, k = W.orders;
        const tx = wx * (0.2 + 0.6 * ((k * 7) % 11) / 10), ty = wy * (0.2 + 0.6 * ((k * 3) % 11) / 10);
        queueAction({ action: 'move', unitIds: ids, targetX: tx, targetY: ty });
        return { ids, tx, ty };
    };
    // In the simulation: how many of these units are headed to (near) the point.
    W.headed = async (ids, tx, ty) => JSON.parse(await simClientRequest('debugEval', { expr: `(() => {
        const want = new Set(${JSON.stringify(ids)}), gx = Math.floor(${tx} / TILE), gy = Math.floor(${ty} / TILE);
        let n = 0, ok = 0;
        for (const u of units) {
            if (!u || u.dead || !want.has(u.id)) continue;
            n++;
            const c = Math.abs(getUnitOrderDestinationCode(u)) - 1;
            if (c >= 0 && Math.hypot(c % GRID_W - gx, Math.floor(c / GRID_W) - gy) <= 12) ok++;
            else if (Math.hypot(Math.floor(u.x / TILE) - gx, Math.floor(u.y / TILE) - gy) <= 12) ok++;
        }
        return [n, ok];
    })()` }));
};
const pageUrl = port => {
    const q = new URLSearchParams(process.env.QUERY || '');
    if (MP && !q.has('simhelpers')) q.set('simhelpers', process.env.SIMHELPERS || '3');
    const qs = q.toString();
    return `http://127.0.0.1:${port}/index.html${qs ? '?' + qs : ''}`;
};
const VIEWPORT = { viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 };
const newPage = async (ctx, errors, role) => {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(role + ': ' + e.message.slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Permissions policy violation/.test(m.text())) errors.push(role + ': ' + m.text().slice(0, 300)); });
    return page;
};
async function startSolo(browser, port, fixture, errors) {
    const ctx = await browser.newContext(VIEWPORT);
    const page = await newPage(ctx, errors, 'solo');
    await page.goto(pageUrl(port), { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(1000);
    await page.evaluate(async fixture => {
        const data = await (await fetch('tests/' + fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        startSoloGame();
    }, fixture);
    await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 300000 });
    const setup = await page.evaluate(() => ({ units: units.length, map: GRID_W, shared: !!(_simClient && _simClient.ctl), tickMs: TICK_MS }));
    return { ctxs: [ctx], pages: { solo: page }, setup };
}
async function startMultiplayer(browser, port, fixture, errors) {
    const ctxH = await browser.newContext(VIEWPORT), ctxG = await browser.newContext(VIEWPORT);
    const host = await newPage(ctxH, errors, 'host'), guest = await newPage(ctxG, errors, 'guest');
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
    const m = MP ? await startMultiplayer(browser, port, fixture, errors) : await startSolo(browser, port, fixture, errors);
    for (const p of Object.values(m.pages)) await p.evaluate(PAGE_SETUP);
    console.log('match', JSON.stringify(m.setup));
    await sleep(WARM_S * 1000);
    const out = { fixture, mode: MP ? 'multiplayer' : 'solo', query: process.env.QUERY || '', setup: m.setup, rows: [], errors };
    const cases = [];
    for (const role of ROLES) for (const ms of STALLS) cases.push({ role, ms, n: 1, gap: 0 });
    if (BURST) for (const role of ROLES) cases.push({ role, ms: BURST_MS, n: BURST, gap: BURST_GAP });
    let worst = 0, ordersLost = 0;
    for (const c of cases) {
        await sleep(2500);
        const total = c.n * c.ms + (c.n - 1) * c.gap;
        // The stall: an order, then the page's main thread busy (nothing
        // else of it runs).
        const stalling = m.pages[c.role].evaluate(async ([ms, n, gap]) => {
            const start = performance.timeOrigin + performance.now();
            const order = window.__stall.order();
            for (let i = 0; i < n; i++) {
                const e = performance.now() + ms;
                while (performance.now() < e) { }
                if (i + 1 < n) await new Promise(r => setTimeout(r, gap));
            }
            return { start, order };
        }, [c.ms, c.n, c.gap]);
        // The other page's order, while that one is stalled.
        const orders = {};
        const other = Object.keys(m.pages).find(r => r !== c.role);
        if (other) { await sleep(Math.min(120, total / 2)); orders[other] = await m.pages[other].evaluate(() => window.__stall.order()); }
        const { start: t0, order } = await stalling;
        orders[c.role] = order;
        await sleep(2500);
        const row = { stalled: c.role, stallMs: c.ms, times: c.n, totalMs: total };
        for (const [role, page] of Object.entries(m.pages)) {
            const ticks = await page.evaluate(() => window.__stall.ticks.slice(-400));
            row[role] = measure(ticks, t0, total, m.setup.tickMs);
            worst = Math.max(worst, row[role].lostTicks);
            // DUMP=1: each tick's end around the stall (ms from its start; * the worker ran it by itself).
            if (process.env.DUMP) {
                const auto = new Set(await page.evaluate(() => window.__stall.auto || []));
                console.log('  ' + role + ': ' + ticks.filter(r => r[1] >= t0 - 150 && r[1] <= t0 + total + 600).map(r => Math.round(r[1] - t0) + (auto.has(r[0]) ? '*' : '')).join(' '));
            }
            const o = orders[role];
            if (o) {
                const [n, ok] = await page.evaluate(([ids, tx, ty]) => window.__stall.headed(ids, tx, ty), [o.ids, o.tx, o.ty]);
                row[role].order = ok + '/' + n;
                if (!(ok >= n * 0.9)) ordersLost++;
            }
        }
        out.rows.push(row);
        console.log(`${c.role} page stalled ${c.n > 1 ? c.n + ' x ' : ''}${c.ms} ms:`, Object.keys(m.pages).map(r => `${r} longest tick gap ${row[r].maxGapMs} ms, ${row[r].lostTicks} ticks lost (${row[r].ticks} of ${row[r].expected})${row[r].order ? ', its order reached ' + row[r].order + ' units' : ''}`).join('; '));
    }
    // The peers' states: the lockstep hash of the same tick, on each worker.
    let equal = null;
    if (MP) {
        await sleep(500);
        const at = Math.max(...await Promise.all(Object.values(m.pages).map(p => p.evaluate(() => simClientStats().appliedTick)))) + 40;
        // (A request runs after the ticks dispatched before it: one every
        // few ms, so one lands right before that tick on each peer.)
        const hashes = await Promise.all(Object.values(m.pages).map(p => p.evaluate(at => new Promise(resolve => {
            const expr = `(self.__hashAt = self.__hashAt || {}, currentTick === ${at} ? (self.__hashAt[${at}] = computeLockstepStateHashFast(${at})) : null, [currentTick, self.__hashAt[${at}] || null])`;
            const t0 = performance.now();
            const h = setInterval(() => {
                if (performance.now() - t0 > 15000) { clearInterval(h); resolve(null); return; }
                simClientRequest('debugEval', { expr }).then(text => { const r = JSON.parse(text); if (r[1] !== null || r[0] > at) { clearInterval(h); resolve(r); } });
            }, 6);
        }), at)));
        equal = hashes.every(h => h && h[1] !== null) ? hashes[0][1] === hashes[1][1] : null;
        out.stateAt = { tick: at, hashes, equal };
        console.log('state at tick', at, equal === null ? 'not compared (the tick passed between requests)' : equal ? 'equal on both peers' : 'DIFFERS');
    }
    for (const [role, page] of Object.entries(m.pages)) out[role] = await page.evaluate(() => ({ net: { lateSeals: netCounters.lateSeals || 0, autoTicks: netCounters.autoTicks || 0, autoSeals: netCounters.autoSeals || 0, carried: netCounters.lateCommandsCarried || 0, desyncs: netCounters.desyncsDetected, patches: netCounters.patches + netCounters.fullPatches, hard: netCounters.hardResyncs }, sim: simClientStats() }));
    for (const role of Object.keys(m.pages)) if (out[role].sim) delete out[role].sim.errors;
    console.log('net', JSON.stringify(Object.fromEntries(Object.keys(m.pages).map(r => [r, out[r].net]))));
    for (const ctx of m.ctxs) await ctx.close();
    const file = process.env.OUT || path.join(__dirname, 'page-stall-tps-probe.json');
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log('written', file, 'errors', errors.length ? errors.slice(0, 8) : 0);
    if (process.env.GATE) {
        const limit = Number(process.env.GATE_TICKS) || 1.5;
        const fail = [];
        if (worst > limit) fail.push(`a stall cost ${worst} ticks (limit ${limit})`);
        if (ordersLost) fail.push(`${ordersLost} orders given around a stall did not run`);
        if (equal === false) fail.push('the peers\' states differ');
        if (Object.keys(m.pages).some(r => out[r].net.desyncs || out[r].net.hard)) fail.push('desyncs');
        if (errors.length) fail.push('page errors');
        if (fail.length) { console.error('page-stall-tps-probe: ' + fail.join('; ')); process.exitCode = 1; } else console.log('page-stall-tps-probe: ok');
    }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
