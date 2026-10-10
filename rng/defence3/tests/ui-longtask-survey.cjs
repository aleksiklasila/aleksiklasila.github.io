'use strict';
// Every UI control, clicked once each in a running big match (real fixture,
// simulation worker, hardware WebGL), with the page's longest task and the
// longest stretch without a tick result after it: no control may stall the
// page (a stalled page dispatches no ticks: in multiplayer everyone waits).
//   node tests/ui-longtask-survey.cjs [fixture] [--pop=N] [--limit-ms=250]
// Writes tests/ui-longtask-survey-results.json. Run alone (big fixture).
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const fixture = args.find(a => !a.startsWith('--')) || '100000-1000.json';
const opt = k => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
const POP = Number(opt('pop')) || 0, LIMIT_MS = Number(opt('limit-ms')) || 250, SETTLE_MS = Number(opt('settle-ms')) || 1500;
// Controls that end the match, leave the page or open a file dialog.
const SKIP = /leave|resign|quit|exit|main.?menu|restart|new.?game|host|join|delete|remove|reset|clear|download|save|export|import|upload|load|surrender|forfeit|disconnect|kick|drop|start|play again|rematch|fullscreen/i;

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
    const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 300)));
    page.on('dialog', d => d.dismiss().catch(() => { }));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.evaluate(async ({ fixture, population }) => {
        const data = await (await fetch('tests/' + fixture)).json();
        if (population) {
            const groups = Object.entries(data.startingResources.spawnCounts).filter(([k]) => k.startsWith('unit:')).map(([, v]) => v);
            const total = groups.reduce((n, g) => n + Object.values(g).reduce((a, b) => a + b, 0), 0); let count = 0;
            for (const g of groups) for (const k of Object.keys(g)) { g[k] = Math.floor(g[k] * population / total); count += g[k]; }
            groups[0][Object.keys(groups[0])[0]] += population - count;
            data.lobby.numbers['cfg-max-pop'] = population;
        }
        applyMainMenuSettingsSnapshot(data);
        startSoloGame();
    }, { fixture, population: POP });
    await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 20, {}, { timeout: 300000 });
    const units = await page.evaluate(() => typeof units !== 'undefined' ? units.length : 0);
    // Long tasks and the gaps between tick results, from now on.
    await page.evaluate(() => {
        const S = window.__survey = { long: [], ticks: [] };
        new PerformanceObserver(list => { for (const e of list.getEntries()) S.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: false });
        let last = -1;
        setInterval(() => { const t = typeof _simClient !== "undefined" && _simClient ? _simClient.appliedTick : currentTick; if (t !== last) { last = t; S.ticks.push(performance.now()); } }, 5);
    });
    await page.waitForTimeout(3000);

    // The visible controls, each by a selector that finds it again.
    const listControls = () => page.evaluate(SKIPSRC => {
        const skip = new RegExp(SKIPSRC, 'i');
        const out = [];
        const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled; };
        const all = document.querySelectorAll('button, select, input[type=checkbox], input[type=radio], [role=tab], .help-tab, [data-tab]');
        all.forEach((el, i) => {
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
    const measure = async (label, act) => {
        const t0 = await page.evaluate(() => performance.now());
        const w0 = Date.now();
        try { await act(); } catch (e) { results.push({ label, error: String(e.message).slice(0, 200) }); return; }
        const actMs = Date.now() - w0;
        await page.waitForTimeout(SETTLE_MS);
        const r = await page.evaluate(t0 => {
            const S = window.__survey;
            const long = S.long.filter(([s]) => s >= t0).map(([, d]) => d);
            const ticks = S.ticks.filter(t => t >= t0 - 200);
            let gap = 0; for (let i = 1; i < ticks.length; i++) gap = Math.max(gap, ticks[i] - ticks[i - 1]);
            return { maxLong: Math.round(Math.max(0, ...long)), longCount: long.length, tickGap: Math.round(gap), ticks: ticks.length };
        }, t0);
        results.push({ label, actMs, ...r });
        if (r.maxLong > LIMIT_MS || r.tickGap > LIMIT_MS) console.log('SLOW', label, JSON.stringify(r), 'act', actMs);
    };

    const done = new Set(), seen = new Set();
    // Closing controls go last at each level (they hide what is being explored).
    const CLOSING = /close|✕|back|cancel|done|^ok|escape/i;
    // Depth first: what a control opens (a popup, a tab) is explored right
    // after it, while it is still open. Revealed: never listed before (a
    // popup that hid the HUD while open does not make the HUD new).
    const explore = async (depth, list = null) => {
        list = list || await listControls();
        for (const x of list) seen.add(x.label);
        list = [...list.filter(c => !CLOSING.test(c.label)), ...list.filter(c => CLOSING.test(c.label))];
        for (const c of list) {
            if (done.has(c.label)) continue;
            const el = page.locator(c.sel);
            if (!(await el.count()) || !(await el.isVisible().catch(() => false))) continue;
            done.add(c.label);
            if (c.tag === 'select') {
                const values = await el.evaluate(s => [...s.options].map(o => o.value));
                const before = await el.inputValue().catch(() => null);
                for (const v of values.slice(0, 6)) await measure(c.label + ' = ' + v, () => el.selectOption(v, { timeout: 2000, force: true }));
                if (before !== null) await el.selectOption(before, { timeout: 2000, force: true }).catch(() => { });
            } else if (c.type === 'checkbox') {
                await measure(c.label + ' (toggle)', () => clickIt(el));
                await measure(c.label + ' (toggle back)', () => clickIt(el));
            } else {
                await measure(c.label, () => clickIt(el));
            }
            if (depth < 6) {
                const fresh = (await listControls()).filter(x => !seen.has(x.label));
                if (process.env.SURVEY_DEBUG) console.log('clicked', c.label.slice(0, 40), 'depth', depth, 'revealed', fresh.length, fresh.slice(0, 5).map(x => x.label.slice(0, 20)).join(' | '));
                if (fresh.length) await explore(depth + 1, fresh);
            }
        }
    };
    // Passes until nothing new is clicked (controls hidden in one pass show in another).
    for (let pass = 0; pass < 4; pass++) { const n = done.size; await explore(0); if (done.size === n) break; }
    // Keys the HUD listens to (help, settings, groups...).
    for (const key of ['h', 'Escape', 'F1', 'Tab', 'm', 'g', '1', '2', 'Control+a']) await measure('key ' + key, () => page.keyboard.press(key));

    results.sort((a, b) => Math.max(b.maxLong || 0, b.tickGap || 0) - Math.max(a.maxLong || 0, a.tickGap || 0));
    const out = { fixture, population: POP || null, units, limitMs: LIMIT_MS, controls: results.length, slow: results.filter(r => (r.maxLong || 0) > LIMIT_MS || (r.tickGap || 0) > LIMIT_MS), errors: errors.slice(0, 20), results };
    fs.writeFileSync(path.join(__dirname, 'ui-longtask-survey-results.json'), JSON.stringify(out, null, 1));
    console.log('controls', results.length, 'slow', out.slow.length, 'errors', errors.length);
    for (const r of results.slice(0, 15)) console.log(JSON.stringify(r));
    await browser.close();
    server.close();
})().catch(e => { console.error(e); process.exit(1); });
