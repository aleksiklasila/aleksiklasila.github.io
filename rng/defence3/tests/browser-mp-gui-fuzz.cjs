'use strict';
// A multiplayer match in real browser tabs (Edge, simulation workers, the
// real GUI), the network a BroadcastChannel stand-in for PeerJS
// (tests/browser-fake-peer.js). Every visible control is clicked on every
// player in turn, keys pressed, and the 2D/3D view switched, while the
// match runs: no desync, no stop, no page error, no long stall.
//   node tests/browser-mp-gui-fuzz.cjs [fixture] [--players=2] [--limit-ms=400]
// Writes tests/browser-mp-gui-fuzz-results.json.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const fixture = args.find(a => !a.startsWith('--')) || '10000-160.json';
const opt = k => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const PLAYERS = Number(opt('players')) || 2, LIMIT_MS = Number(opt('limit-ms')) || 400, SETTLE_MS = Number(opt('settle-ms')) || 700;
const SKIP = /leave|resign|quit|exit|main.?menu|restart|new.?game|host|join|delete|remove|reset|clear|download|save|export|import|upload|load|surrender|forfeit|disconnect|kick|drop|start|play again|rematch|fullscreen|spectat/i;

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
    const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
    await context.addInitScript({ path: path.join(__dirname, 'browser-fake-peer.js') });
    const pages = [], errors = [];
    const open = async (name, url) => {
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(name + ': ' + e.message.slice(0, 300)));
        page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 300)); });
        page.on('dialog', d => d.dismiss().catch(() => { }));
        await page.goto(url);
        page.__name = name;
        pages.push(page);
        return page;
    };
    const host = await open('host', base + '/index.html');
    await host.evaluate(async fixture => {
        const data = await (await fetch('tests/' + fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        loadOrCreateLocalIdentity(); hostOnlineGame();
    }, fixture);
    await host.waitForFunction(() => !!myPeerId, {}, { timeout: 20000 });
    const hostId = await host.evaluate(() => myPeerId);
    for (let i = 1; i < PLAYERS; i++) {
        const g = await open('guest' + i, `${base}/index.html?game=${hostId}&room=${hostId}`);
        await g.evaluate(hostId => { loadOrCreateLocalIdentity(); joinGame(hostId); }, hostId);
    }
    await host.waitForFunction(n => lobbyPlayers.length >= n && connections.length >= n - 1, PLAYERS, { timeout: 30000 });
    // Each player its own team color.
    for (let i = 0; i < pages.length; i++) {
        await pages[i].evaluate(i => {
            const me = lobbyPlayers.find(p => p.peerId === myPeerId);
            if (!me) return;
            me.color = TEAM_PRESET_COLORS[i];
            if (isHost) broadcastLobbyState(true); else connections[0].send({ type: 'LOBBY_UPDATE_SELF', name: me.name, color: me.color });
        }, i);
    }
    await host.waitForTimeout(1500);
    await host.evaluate(() => startHostedGame());
    for (const p of pages) await p.waitForFunction(() => gameStarted && !matchStartWaitingForReady && currentTick > 30, {}, { timeout: 180000 });
    console.log('match running on', pages.length, 'tabs');

    // Stalls (long tasks, gaps between tick results) per tab.
    for (const p of pages) await p.evaluate(() => {
        const S = window.__survey = { long: [], ticks: [] };
        new PerformanceObserver(list => { for (const e of list.getEntries()) S.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false });
        let last = -1;
        setInterval(() => { const t = typeof _simClient !== 'undefined' && _simClient ? _simClient.appliedTick : currentTick; if (t !== last) { last = t; S.ticks.push(performance.now()); } }, 5);
    });
    const health = () => Promise.all(pages.map(p => p.evaluate(() => ({
        tick: currentTick, desyncs: netCounters.desyncsDetected, patches: netCounters.patches, full: netCounters.fullPatches, hard: netCounters.hardResyncs,
        stop: lockstepFatalStopActive, started: gameStarted, over: gameOver, mp: isMultiplayer, paused: lockstepResyncPauseActive
    }))));
    const h0 = await health();
    console.log('start', JSON.stringify(h0));

    const listControls = page => page.evaluate(SKIPSRC => {
        const skip = new RegExp(SKIPSRC, 'i');
        const out = [];
        const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled; };
        document.querySelectorAll('button, select, input[type=checkbox], input[type=radio], input[type=range], [role=tab], .help-tab, [data-tab]').forEach((el, i) => {
            if (!visible(el)) return;
            const label = (el.id || '') + ' ' + (el.textContent || '').trim().slice(0, 40) + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.title || '');
            if (skip.test(label)) return;
            if (!el.dataset.surveyId) el.dataset.surveyId = 's' + i + '_' + Math.random().toString(36).slice(2, 7);
            out.push({ sel: `[data-survey-id="${el.dataset.surveyId}"]`, label: label.replace(/\s+/g, ' ').trim(), tag: el.tagName.toLowerCase(), type: el.type || '' });
        });
        return out;
    }, SKIP.source);

    const results = [];
    // (A control under an open popup: clicked as the page's own code would.)
    const clickIt = async el => { try { await el.click({ timeout: 300 }); } catch { await el.evaluate(e => e.click()); } };
    const measure = async (page, label, act) => {
        const t0s = await Promise.all(pages.map(p => p.evaluate(() => performance.now())));
        try { await act(); } catch (e) { results.push({ page: page.__name, label, error: String(e.message).slice(0, 160) }); return; }
        await page.waitForTimeout(SETTLE_MS);
        const per = await Promise.all(pages.map((p, k) => p.evaluate(t0 => {
            const S = window.__survey;
            const long = S.long.filter(([s]) => s >= t0).map(([, d]) => d);
            const ticks = S.ticks.filter(t => t >= t0 - 200);
            let gap = 0; for (let i = 1; i < ticks.length; i++) gap = Math.max(gap, ticks[i] - ticks[i - 1]);
            gap = Math.max(gap, performance.now() - (ticks[ticks.length - 1] || t0));
            return { maxLong: Math.round(Math.max(0, ...long)), tickGap: Math.round(gap) };
        }, t0s[k])));
        const r = { page: page.__name, label, maxLong: Math.max(...per.map(x => x.maxLong)), tickGap: Math.max(...per.map(x => x.tickGap)), per: per.map((x, k) => pages[k].__name + ":" + x.maxLong + "/" + x.tickGap).join(" ") };
        results.push(r);
        if (r.maxLong > LIMIT_MS || r.tickGap > LIMIT_MS) console.log('SLOW', JSON.stringify(r));
    };

    const CLOSING = /close|✕|back|cancel|done|^ok|escape/i;
    for (const page of pages) {
        // Depth first, as tests/ui-longtask-survey.cjs: what a control opens
        // is explored while open; closing controls last at each level.
        const done = new Set(), seen = new Set();
        const actOn = async c => {
            const el = page.locator(c.sel);
            if (c.tag === 'select') {
                const values = await el.evaluate(s => [...s.options].map(o => o.value)).catch(() => []);
                const before = await el.inputValue().catch(() => null);
                for (const v of values.slice(0, 5)) await measure(page, c.label + ' = ' + v, () => el.selectOption(v, { timeout: 2000, force: true }));
                if (before !== null) await el.selectOption(before, { timeout: 2000, force: true }).catch(() => { });
            } else if (c.type === 'range') {
                await measure(page, c.label + ' (range)', () => el.evaluate(r => { r.value = r.max || r.value; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); }));
            } else if (c.type === 'checkbox') {
                await measure(page, c.label + ' (toggle)', () => clickIt(el));
                await measure(page, c.label + ' (toggle back)', () => clickIt(el));
            } else {
                await measure(page, c.label, () => clickIt(el));
            }
        };
        const explore = async (depth, list = null) => {
            list = list || await listControls(page);
            for (const x of list) seen.add(x.label);
            list = [...list.filter(c => !CLOSING.test(c.label)), ...list.filter(c => CLOSING.test(c.label))];
            for (const c of list) {
                if (done.has(c.label)) continue;
                const el = page.locator(c.sel);
                if (!(await el.count()) || !(await el.isVisible().catch(() => false))) continue;
                done.add(c.label);
                await actOn(c);
                if (depth < 6) {
                    const fresh = (await listControls(page)).filter(x => !seen.has(x.label));
                    if (fresh.length) await explore(depth + 1, fresh);
                }
            }
        };
        for (let pass = 0; pass < 4; pass++) { const n = done.size; await explore(0); if (done.size === n) break; }
        for (const key of ['h', 'Escape', 'Tab', 'm', 'g', '1', 'Control+1', '1', 'Escape', 's', 'a', 'Delete', 'Escape']) await measure(page, 'key ' + key, () => page.keyboard.press(key));
        // The 2D/3D views, and the tab hidden for a while (another tab in front).
        if (await page.evaluate(() => typeof setRenderDimensionMode === 'function')) {
            await measure(page, 'view 3d', () => page.evaluate(() => setRenderDimensionMode('3d')));
            await measure(page, 'view 2d', () => page.evaluate(() => setRenderDimensionMode('2d')));
        }
    }
    await host.waitForTimeout(3000);
    const h1 = await health();
    console.log('end', JSON.stringify(h1));
    // The tick hashes every tab recorded, compared.
    const hashes = await Promise.all(pages.map(p => p.evaluate(() => {
        const out = {}; const t = currentTick;
        for (let k = t - 400; k < t; k++) { const h = typeof snapGetTickHash === 'function' ? snapGetTickHash(k) : null; if (h) out[k] = h.sum; }
        return out;
    })));
    let compared = 0, mismatched = 0;
    for (const k of Object.keys(hashes[0])) for (let i = 1; i < hashes.length; i++) if (hashes[i][k] !== undefined) { compared++; if (hashes[i][k] !== hashes[0][k]) mismatched++; }
    const desyncs = h1.reduce((n, x, i) => n + x.desyncs - h0[i].desyncs, 0);
    const slow = results.filter(r => (r.maxLong || 0) > LIMIT_MS || (r.tickGap || 0) > LIMIT_MS);
    const out = { fixture, players: PLAYERS, controls: results.length, desyncs, compared, mismatched, stopped: h1.some(x => x.stop), ended: h1.some(x => !x.mp || !x.started), errors: errors.slice(0, 30), slow, health: [h0, h1], results };
    fs.writeFileSync(path.join(__dirname, 'browser-mp-gui-fuzz-results.json'), JSON.stringify(out, null, 1));
    console.log(JSON.stringify({ controls: results.length, desyncs, compared, mismatched, stopped: out.stopped, ended: out.ended, errors: errors.length, slow: slow.length }));
    for (const e of errors.slice(0, 10)) console.log('ERROR', e);
    await browser.close();
    server.close();
    process.exit(desyncs || mismatched || out.stopped || out.ended || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
