// Own vs enemy 3D detail in a load preset (2m|4m|8m) in headed Edge: per
// owner, how the readable units near the camera are drawn (detail model,
// middle model, glyph) at an own, an enemy and a mixed spot and three zooms,
// plus panel raster fallbacks. Before the frame-order fix (slots past 2^21,
// tests/frame-order-slots.test.cjs) the 4M enemy army was glyphs only:
// tests/test-runs/enemy-lod-20261022.
//   NODE_PATH=<playwright> node tests/enemy-lod.probe.cjs 4m   (OUT, VIS)
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.OUT || require('node:os').tmpdir(), size = process.argv[2] || '4m';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html';
    fs.readFile(path.resolve(root, name), (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'same-origin' });
        res.end(data);
    });
});
const t0 = Date.now(), log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ channel: 'msedge', headless: false,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
            '--disable-features=CalculateNativeWinOcclusion', '--window-size=1600,950'] });
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 300)));
    page.on('crash', () => log('CRASH'));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?loadmetrics=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.loadMetrics && typeof startSoloGame === 'function', {}, { timeout: 60000 });
    await page.evaluate(s => loadMetrics.loadPreset(s), size);
    if (process.env.VIS) await page.evaluate(v => { document.getElementById('cfg-full-vis').value = v; }, process.env.VIS);
    await page.evaluate(() => { setTimeout(() => startSoloGame(), 0); });
    log('play clicked');
    for (;;) {
        await sleep(5000);
        const st = await Promise.race([page.evaluate(() => ({ started: typeof gameStarted !== 'undefined' && gameStarted, tick: typeof simClientStats === 'function' ? simClientStats().appliedTick : -1,
            units: typeof units !== 'undefined' ? units.length : 0 })), sleep(20000).then(() => null)]);
        if (st) log(JSON.stringify(st));
        if (st && st.started && st.tick >= 20) break;
        if (Date.now() - t0 > 15 * 60000) { log('timeout'); process.exit(2); }
    }
    await sleep(5000);
    const info = await page.evaluate(() => ({ full: fullVisibility, player: localPlayerId, GW: GRID_W, n: units.length }));
    log('info', JSON.stringify(info));
    // Spots: a cell mixing both owners, one of own units, one of enemies.
    const spots = await page.evaluate(() => {
        const F = simClientCurrentUnitVis(), C = 8, gw = Math.ceil(GRID_W / C), gh = Math.ceil(GRID_H / C), own = new Int32Array(gw * gh), en = new Int32Array(gw * gh);
        for (let s = 0; s < F.n; s++) { if (F.id[s] < 0 || F.energy[s] <= 0 || (F.flags[s] & 1024)) continue;
            const k = Math.min(gh - 1, Math.max(0, Math.floor(F.y[s] / TILE / C))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(F.x[s] / TILE / C)));
            if (F.owner[s] === localPlayerId) own[k]++; else en[k]++; }
        const pick = f => { let best = -1, bk = 0; for (let k = 0; k < own.length; k++) { const v = f(own[k], en[k]); if (v > best) { best = v; bk = k; } } return { x: (bk % gw + .5) * C, y: (Math.floor(bk / gw) + .5) * C, own: own[bk], en: en[bk] }; };
        return { mixed: pick((a, b) => Math.min(a, b)), own: pick((a, b) => a - 4 * b), enemy: pick((a, b) => b - 4 * a) };
    });
    log('spots', JSON.stringify(spots));
    await page.evaluate(() => { const b = document.getElementById('btn-view-3d'); if (b) b.click(); });
    await page.evaluate(() => {
        const orig = get3DExact2DTexture;
        window.__pan = { own: { calls: 0, exact: 0, fallback: 0 }, enemy: { calls: 0, exact: 0, fallback: 0 } };
        get3DExact2DTexture = function (entity, useUnitBudget) {
            const r = orig.apply(this, arguments);
            if (useUnitBudget && entity) { const e = window.__pan[entity.owner === localPlayerId ? 'own' : 'enemy']; e.calls++; if (renderer3dExactTextureFallback) e.fallback++; else e.exact++; }
            return r;
        };
    });
    const measure = () => page.evaluate(() => {
        const F = simClientCurrentUnitVis(), dm = _detailMask, R = renderer3dInstance, mm = R.columnModels && R.columnModels.masks ? R.columnModels.masks[1] : null, c = {};
        for (let s = 0; s < F.n; s++) {
            if (F.id[s] < 0 || F.energy[s] <= 0 || (F.flags[s] & (1024 | 65536))) continue;
            const x = F.x[s] / TILE, z = F.y[s] / TILE, size = Math.max(.28, Math.min(.9, F.r[s] * 2.2 / TILE));
            if (!fullVisibility && F.owner[s] !== localPlayerId && !(visibilityGrid[Math.floor(z)]?.[Math.floor(x)] > 0)) continue;
            const big = _detailScore(x, z, size, false, false, 24) > 0, mid = _detailScore(x, z, size, false, false, 10) > 0;
            if (!mid) continue;
            const k = (F.owner[s] === localPlayerId ? 'own' : 'enemy') + (big ? '-big' : '-mid'), e = c[k] ||= { n: 0, detail: 0, middle: 0, glyph: 0 };
            e.n++; if (dm && dm[s]) e.detail++; else if (mm && mm[s]) e.middle++; else e.glyph++;
        }
        return { c, panels: JSON.parse(JSON.stringify(window.__pan)), slotMode: R.columnModels && R.columnModels.slotMode, atlasComplete: !!(R.columnAtlas && R.columnAtlas.complete) };
    });
    const results = [];
    for (const [name, sp] of Object.entries(spots)) for (const zoom of [1.5, 2.5, 4]) {
        await page.evaluate(([z, x, y]) => { camera.zoom = z; camera.x = x * TILE - viewW / camera.zoom / 2; camera.y = y * TILE - viewH / camera.zoom / 2; clampCamera();
            for (const k of ['own', 'enemy']) for (const q in window.__pan[k]) window.__pan[k][q] = 0; }, [zoom, sp.x, sp.y]);
        await sleep(4000);
        const r = await Promise.race([measure(), sleep(30000).then(() => ({ timeout: true }))]);
        log(name, zoom, JSON.stringify(r));
        results.push({ name, zoom, ...r });
        await page.screenshot({ path: path.join(out, `lod${size}-${name}-z${zoom}.png`) }).catch(() => {});
    }
    fs.writeFileSync(path.join(out, `lod${size}.json`), JSON.stringify({ info, spots, results, errors }, null, 1));
    log('errors', JSON.stringify(errors.slice(0, 5)));
    await browser.close(); server.close();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(2); });
