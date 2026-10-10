'use strict';
// A big match in real tabs (Edge, workers; tests/browser-fake-peer.js as the
// network): a player joins mid-match, then one reloads. The host builds and
// sends the whole match meanwhile: the players already in it must not stall
// (their longest task and longest gap between tick results), and all agree
// after (no desync, same hashes).
//   node tests/browser-mp-join-stall.cjs [fixture] [--limit-ms=400]
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const fixture = args.find(a => !a.startsWith('--')) || '50000-200.json';
const opt = k => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const LIMIT_MS = Number(opt('limit-ms')) || 400;

const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (error, data) => {
        if (error) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }).end(data);
    });
});

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const context = await browser.newContext({ viewport: { width: 1000, height: 680 } });
    await context.addInitScript({ path: path.join(__dirname, 'browser-fake-peer.js') });
    const errors = [];
    const open = async (name, url) => {
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(name + ': ' + e.message.slice(0, 300)));
        page.on('dialog', d => d.dismiss().catch(() => { }));
        await page.goto(url);
        page.__name = name;
        return page;
    };
    const watch = page => page.evaluate(() => {
        const S = window.__survey = { long: [], ticks: [] };
        new PerformanceObserver(list => { for (const e of list.getEntries()) S.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false });
        let last = -1;
        setInterval(() => { const t = typeof _simClient !== 'undefined' && _simClient ? _simClient.appliedTick : currentTick; if (t !== last) { last = t; S.ticks.push(performance.now()); } }, 5);
    });
    const window_ = async (pages, label, fn, settleMs) => {
        const t0 = await Promise.all(pages.map(p => p.evaluate(() => performance.now())));
        await fn();
        await pages[0].waitForTimeout(settleMs);
        const per = await Promise.all(pages.map((p, k) => p.evaluate(t0 => {
            const S = window.__survey; const long = S.long.filter(([s]) => s >= t0).map(([, d]) => d);
            const ticks = S.ticks.filter(t => t >= t0 - 200); let gap = 0; for (let i = 1; i < ticks.length; i++) gap = Math.max(gap, ticks[i] - ticks[i - 1]);
            return { maxLong: Math.round(Math.max(0, ...long)), longSum: Math.round(long.reduce((a, b) => a + b, 0)), tickGap: Math.round(gap), ticks: ticks.length };
        }, t0[k])));
        const row = { label, per: Object.fromEntries(per.map((x, k) => [pages[k].__name, x])) };
        console.log(JSON.stringify(row));
        return row;
    };

    const host = await open('host', base + '/index.html');
    await host.evaluate(async fixture => { const data = await (await fetch('tests/' + fixture)).json(); applyMainMenuSettingsSnapshot(data); loadOrCreateLocalIdentity(); hostOnlineGame(); }, fixture);
    await host.waitForFunction(() => !!myPeerId, {}, { timeout: 20000 });
    const hostId = await host.evaluate(() => myPeerId);
    const g1 = await open('guest1', `${base}/index.html?game=${hostId}&room=${hostId}`);
    await g1.evaluate(id => { loadOrCreateLocalIdentity(); joinGame(id); }, hostId);
    await host.waitForFunction(() => lobbyPlayers.length >= 2 && connections.length >= 1, {}, { timeout: 30000 });
    for (const [i, p] of [host, g1].entries()) await p.evaluate(i => { const me = lobbyPlayers.find(p => p.peerId === myPeerId); if (!me) return; me.color = TEAM_PRESET_COLORS[i]; if (isHost) broadcastLobbyState(true); else connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color }); }, i);
    await host.waitForTimeout(1500);
    await host.evaluate(() => startHostedGame());
    for (const p of [host, g1]) await p.waitForFunction(() => gameStarted && !matchStartWaitingForReady && currentTick > 30, {}, { timeout: 300000 });
    const units = await host.evaluate(() => typeof _simClient !== 'undefined' && _simClient && _simClient.unitCount ? _simClient.unitCount : units.length);
    console.log('match running', fixture, 'units (page view)', units);
    for (const p of [host, g1]) await watch(p);
    await host.waitForTimeout(3000);
    const rows = [];
    rows.push(await window_([host, g1], 'baseline', async () => { }, 4000));
    // A third player joins as a spectator mid-match.
    let g2;
    rows.push(await window_([host, g1], 'spectator joins', async () => {
        g2 = await open('guest2', `${base}/index.html?game=${hostId}&room=${hostId}`);
        await g2.evaluate(id => { loadOrCreateLocalIdentity(); joinGame(id); }, hostId);
        // (In the lobby of a running match: asks to watch it, as its button does.)
        await g2.waitForFunction(() => typeof remoteMatchRunning !== 'undefined' && remoteMatchRunning, {}, { timeout: 30000 }).catch(() => { });
        await g2.evaluate(() => requestSpectateCurrentMatch());
        await g2.waitForFunction(() => gameStarted && currentTick > 0, {}, { timeout: 120000 }).catch(() => { });
    }, 4000));
    // The playing guest reloads its page and comes back.
    rows.push(await window_([host], 'guest reloads', async () => {
        await g1.reload();
        await g1.evaluate(id => { loadOrCreateLocalIdentity(); joinGame(id); }, hostId).catch(() => { });
        await g1.waitForFunction(() => gameStarted && currentTick > 0, {}, { timeout: 120000 }).catch(() => { });
    }, 5000));
    const health = await Promise.all([host, g1, g2].filter(Boolean).map(p => p.evaluate(() => ({ tick: currentTick, started: gameStarted, desyncs: netCounters.desyncsDetected, hard: netCounters.hardResyncs, patches: netCounters.patches, stop: lockstepFatalStopActive, mp: isMultiplayer }))));
    console.log('health', JSON.stringify(health));
    const slow = rows.filter(r => Object.values(r.per).some(x => x.maxLong > LIMIT_MS || x.tickGap > LIMIT_MS));
    fs.writeFileSync(path.join(__dirname, 'browser-mp-join-stall-results.json'), JSON.stringify({ fixture, units, rows, health, errors: errors.slice(0, 20) }, null, 1));
    console.log(JSON.stringify({ slow: slow.map(r => r.label), errors: errors.length }));
    for (const e of errors.slice(0, 8)) console.log('ERROR', e);
    await browser.close(); server.close();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
