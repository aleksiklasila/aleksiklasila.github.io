'use strict';
// Random real-input UI fuzzing in Microsoft Edge (headed: native drag and
// drop and hover behave as for a player). A solo match; mouse moves, clicks,
// drags and wheel over the canvas and every visible control, with and without
// Ctrl/Shift, plus game keys. After each step: page errors, native drags that
// were not blocked, stray page selections, hover text showing with no
// modifier held, long frames and the tick rate.
//   NODE_PATH=<dir with playwright> node tests/ui-fuzz.cjs [fixture]
//   env: STEPS (default 400), SEED, HEADED (default 1), OUT (json report),
//        QUERY (page URL query, e.g. guards=0 to check the fuzzer catches page drags)
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
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

let seed = Number(process.env.SEED) || 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = list => list[Math.floor(rand() * list.length)];
const W = 1600, H = 900;

// Installed in the page once: counters the fuzzer reads after each step.
function installProbe() {
    window.__fuzz = { drags: [], frames: [], last: performance.now() };
    window.addEventListener('dragstart', ev => {
        if (!ev.defaultPrevented) __fuzz.drags.push((ev.target.nodeName || '?') + '#' + (ev.target.id || '') + '.' + String(ev.target.className || '').slice(0, 40));
    });
    const frame = now => { __fuzz.frames.push(now - __fuzz.last); __fuzz.last = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
}

function readProbe(modifiers) {
    const editable = el => el && (el.isContentEditable || el.nodeName === 'TEXTAREA' || (el.nodeName === 'INPUT' && !/^(checkbox|radio|range|button|submit|reset|file|color)$/i.test(el.type)));
    const sel = getSelection();
    const visible = id => { const el = document.getElementById(id); return !!(el && !el.hidden && el.offsetParent !== null); };
    const frames = __fuzz.frames.splice(0);
    return {
        drags: __fuzz.drags.splice(0),
        selection: sel.type === 'Range' && !editable(document.activeElement) ? sel.toString().slice(0, 60) || '(hidden range)' : null,
        hoverTip: !modifiers && visible('hover-text-tip'),
        sliderTip: !modifiers && visible('count-slider-tooltip'),
        // Every button is up between steps: no drag may still be running.
        stuck: [typeof isBoxSelecting !== 'undefined' && isBoxSelecting && 'box selection', typeof renderer3dRotateDrag !== 'undefined' && renderer3dRotateDrag && '3D orbit',
            typeof buildPlacementDragActive !== 'undefined' && buildPlacementDragActive && 'build placement', typeof activeCountBar !== 'undefined' && activeCountBar && 'slider'].filter(Boolean),
        // Layout boxes scrolled by the browser (focus, scrollIntoView, edge
        // drags) shift the whole screen; scrollable panels are fine.
        scrolled: [document.scrollingElement, document.body, ...document.querySelectorAll('#main-row, #center-column, #game-area, #left-panel, #right-panel, #bottom-bar, #build-bar, #minimap-wrap')]
            .filter(el => el && (el.scrollTop || el.scrollLeft)).map(el => (el.id || el.nodeName) + ' ' + el.scrollLeft + ',' + el.scrollTop),
        // The drawn canvas must cover its game area exactly.
        canvasOff: (() => {
            const area = document.getElementById('game-area');
            const c = [...area.querySelectorAll('canvas')].find(c => c.offsetParent !== null);
            if (!c) return null;
            const a = area.getBoundingClientRect(), r = c.getBoundingClientRect();
            const off = Math.max(Math.abs(a.left - r.left), Math.abs(a.top - r.top), Math.abs(a.width - r.width), Math.abs(a.height - r.height));
            return off > 4 ? [a, r].map(b => [b.left, b.top, b.width, b.height].map(Math.round).join(',')).join(' vs ') : null;
        })(),
        // Open menus and popups that run off the screen.
        offscreen: [...document.querySelectorAll('[role="dialog"], [role="menu"], .bb-menu, [id$="-popup"], [id$="-menu"], [class*="dropdown"]')]
            .filter(el => el.offsetParent !== null && getComputedStyle(el).position !== 'static').map(el => [el, el.getBoundingClientRect()])
            .filter(([, r]) => r.width > 0 && (r.left < -2 || r.top < -2 || r.right > innerWidth + 2 || r.bottom > innerHeight + 2))
            .map(([el, r]) => (el.id || el.className).toString().slice(0, 40) + ' ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',')),
        maxFrame: frames.length ? Math.max(...frames) : 0,
        frames: frames.length,
        tick: typeof simClientStats === 'function' ? simClientStats().appliedTick : -1,
        started: typeof gameStarted !== 'undefined' && gameStarted,
        focus: document.activeElement ? document.activeElement.nodeName + '#' + (document.activeElement.id || '') : '',
    };
}

function clickableTargets() {
    const out = [];
    const selector = 'button, [class*="btn"], input, select, summary, .count-slider, .bb-thing, .bb-task, .build-item, .build-tab, [class*="toggle"], [class*="tab"], [class*="-item"], [class*="option"], '
        + '[data-id], [data-key], [data-thing-id], [data-tab], [data-action], [data-mode], [data-filter], [style*="cursor:pointer"], [style*="cursor: pointer"]';
    const seen = new Set();
    for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        // Leaving the match, files, links: out of scope for an in-match fuzz.
        if (/leave|quit|exit|restart|surrender|import|export|external|fullscreen|btn-start|host|join/i.test(el.id + ' ' + el.className + ' ' + el.textContent.slice(0, 30))) continue;
        if (el.type === 'file') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !(hit === el || el.contains(hit))) continue;
        // Controls inside a popup, menu or dialog: the submenus to explore.
        const inMenu = !!el.closest('[role="dialog"], [role="menu"], .bb-menu, [id$="-popup"], [id$="-menu"], [class*="dropdown"], [class*="popup"]');
        out.push({ x: cx, y: cy, w: r.width, inMenu, label: (el.id || el.className || el.nodeName).toString().slice(0, 50) + (el.textContent ? ' "' + el.textContent.trim().slice(0, 16) + '"' : '') });
    }
    return out;
}

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ channel: 'msedge', headless: process.env.HEADED === '0' });
    const page = await (await browser.newContext({ viewport: { width: W, height: H } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Permissions policy/.test(m.text())) errors.push(m.text().slice(0, 300)); });
    page.on('dialog', d => d.dismiss().catch(() => {}));
    page.on('filechooser', () => {});
    page.context().on('page', p => p.close().catch(() => {}));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html${process.env.QUERY ? "?" + process.env.QUERY : ""}`, { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    const fixture = process.argv[2] || '';
    const start = async () => {
        await page.evaluate(async fixture => {
            if (fixture) { const data = await (await fetch('tests/' + fixture)).json(); applyMainMenuSettingsSnapshot(data); }
            startSoloGame();
        }, fixture);
        await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 180000 });
    };
    await start();
    await page.evaluate(installProbe);
    const steps = Number(process.env.STEPS) || 400;
    const issues = [];
    const log = (step, action, kind, detail) => { issues.push({ step, action, kind, detail }); console.log(`#${step} ${action}: ${kind} ${JSON.stringify(detail)}`); };
    let tickAt = await page.evaluate(() => simClientStats().appliedTick), timeAt = Date.now();
    const tpsSamples = [];
    const keys = ['Escape', 'z', 'x', 'c', 'f', 'q', 'e', '1', '2', '3', 'r', 't', 'Tab', 'Enter', 'Delete', 'ArrowLeft', 'ArrowUp', 'w', 'a', 's', 'd', ' ', 'h', 'b', 'm'];
    for (let step = 0; step < steps; step++) {
        const roll = rand();
        const mods = rand() < 0.35 ? pick([['Shift'], ['Control'], ['Shift', 'Control']]) : [];
        let action = '';
        try {
            for (const m of mods) await page.keyboard.down(m);
            const targets = roll < 0.45 ? await page.evaluate(clickableTargets) : [];
            const pos = targets.length && rand() < 0.85 ? pick(targets) : { x: 5 + rand() * (W - 10), y: 5 + rand() * (H - 10), label: 'any' };
            if (roll < 0.45) {
                action = `${mods.join('+')}${mods.length ? '+' : ''}click ${pos.label}`;
                await page.mouse.move(pos.x, pos.y, { steps: 2 });
                if (rand() < 0.15) await page.waitForTimeout(700); // a hover pause
                await page.mouse.click(pos.x, pos.y, { button: rand() < 0.15 ? 'right' : 'left' });
                const before = new Set(targets.map(t => t.label + Math.round(t.x) + ',' + Math.round(t.y)));
                for (let depth = 0; depth < 3 && rand() < 0.75; depth++) {
                    await page.waitForTimeout(80);
                    const now = await page.evaluate(clickableTargets);
                    const fresh = now.filter(t => !before.has(t.label + Math.round(t.x) + ',' + Math.round(t.y)));
                    const pool = fresh.length ? fresh : now.filter(t => t.inMenu);
                    if (!pool.length) break;
                    const next = pick(pool);
                    action += ' > ' + next.label;
                    await page.mouse.move(next.x, next.y, { steps: 2 });
                    await page.mouse.click(next.x, next.y);
                    for (const t of now) before.add(t.label + Math.round(t.x) + ',' + Math.round(t.y));
                }
            } else if (roll < 0.65) {
                const to = { x: 5 + rand() * (W - 10), y: 5 + rand() * (H - 10) };
                action = `${mods.join('+')}${mods.length ? '+' : ''}drag ${Math.round(pos.x)},${Math.round(pos.y)}->${Math.round(to.x)},${Math.round(to.y)}`;
                await page.mouse.move(pos.x, pos.y);
                await page.mouse.down({ button: rand() < 0.2 ? 'right' : 'left' });
                await page.mouse.move(to.x, to.y, { steps: 8 });
                await page.mouse.up({ button: 'left' }).catch(() => {});
                await page.mouse.up({ button: 'right' }).catch(() => {});
            } else if (roll < 0.75) {
                action = `${mods.join('+')}${mods.length ? '+' : ''}hover ${Math.round(pos.x)},${Math.round(pos.y)}`;
                await page.mouse.move(pos.x, pos.y, { steps: 4 });
                await page.waitForTimeout(400);
            } else if (roll < 0.85) {
                action = 'wheel';
                await page.mouse.move(pos.x, pos.y);
                await page.mouse.wheel(0, (rand() < 0.5 ? -1 : 1) * 300);
            } else {
                const key = rand() < 0.1 ? 'a' : pick(keys);
                action = `${mods.join('+')}${mods.length ? '+' : ''}key ${key}`;
                await page.keyboard.press(key);
            }
            // While modifiers are held, hover text may show; release and then check.
            for (const m of mods.reverse()) await page.keyboard.up(m);
            await page.waitForTimeout(60);
            const s = await page.evaluate(readProbe, false);
            if (s.drags.length) log(step, action, 'native drag started', s.drags);
            if (s.selection) log(step, action, 'page selection', s.selection);
            if (s.hoverTip) log(step, action, 'hover text visible with no modifier', '');
            if (s.sliderTip) log(step, action, 'slider tooltip visible with no modifier', '');
            if (s.stuck.length) log(step, action, 'drag still active', s.stuck);
            if (s.scrolled.length) log(step, action, 'layout scrolled', s.scrolled);
            if (s.canvasOff) log(step, action, 'canvas off its area', s.canvasOff);
            if (s.offscreen.length) log(step, action, 'menu off screen', s.offscreen);
            if (s.maxFrame > 250) log(step, action, 'long frame', Math.round(s.maxFrame));
            if (!s.started) { log(step, action, 'match ended', ''); await start(); await page.evaluate(installProbe); }
            if (Date.now() - timeAt > 5000) {
                tpsSamples.push((s.tick - tickAt) / ((Date.now() - timeAt) / 1000));
                tickAt = s.tick; timeAt = Date.now();
            }
            while (errors.length) log(step, action, 'error', errors.shift());
        } catch (e) {
            log(step, action, 'fuzzer exception', e.message.slice(0, 200));
            for (const m of ['Shift', 'Control']) await page.keyboard.up(m).catch(() => {});
        }
    }
    const report = { steps, seed: Number(process.env.SEED) || 12345, issues, tps: tpsSamples.map(v => Math.round(v * 10) / 10) };
    console.log('TPS samples', report.tps.join(' '));
    console.log(`issues: ${issues.length}`);
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(report, null, 1));
    await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
