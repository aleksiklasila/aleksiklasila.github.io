// View modes in real Edge: 2D / 2.5D / 3D / 3.5D buttons, Space (short:
// team colours, held: 2D <-> 3D), the camera past the map's edges, base
// model heights at high levels, and own vs enemy units' detail models in 3D.
// Screenshots per mode into OUT (default tests/test-runs/view-modes/).
//   NODE_PATH=<playwright> node tests/view-modes.probe.cjs [fixture]
'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.OUT || path.join(__dirname, 'test-runs/view-modes');
fs.mkdirSync(out, { recursive: true });
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html';
    fs.readFile(path.resolve(root, name), (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
        res.end(data);
    });
});
const results = {};
const check = (name, ok, info) => { results[name] = { ok: !!ok, info }; console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? ' ' + JSON.stringify(info) : '')); };
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED });
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 860 } })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|Permissions policy/.test(m.text())) errors.push(m.text().slice(0, 300)); });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    const fixture = process.argv[2] || '', fullVisibilityRun = (process.env.VIS || 'full') === 'full';
    // (Full visibility: the enemies spawned below are seen wherever they
    // walk, for the detail check; VIS=team|history for the others.)
    await page.evaluate(async ([fixture, vis]) => {
        if (fixture) { const data = await (await fetch('tests/' + fixture)).json(); applyMainMenuSettingsSnapshot(data); }
        document.getElementById('cfg-full-vis').value = vis;
        startSoloGame();
    }, [fixture, process.env.VIS || 'full']);
    await page.waitForFunction(() => typeof gameStarted !== 'undefined' && gameStarted && typeof simClientStats === 'function' && simClientStats().appliedTick >= 5, {}, { timeout: 240000 });
    await page.waitForTimeout(1500);
    // Units of both owners in front of the camera: own at the left, enemy at the right.
    await page.evaluate(() => simClientWorkerEval(`(() => {
        const cx = Math.floor(GRID_W / 2), cy = Math.floor(GRID_H / 2), types = ['norm', 'tank', 'fast', 'water_resistant', 'laser_resistant'];
        for (let k = 0; k < 30; k++) for (const owner of [0, 1]) {
            const x = (cx + (owner ? 2 : -3) + (k % 3)) * TILE + 16, y = (cy - 5 + Math.floor(k / 3)) * TILE + 16;
            const u = new Unit(types[k % types.length], owner, x, y); if (u.dead) continue; units.push(u); players[owner].popCount++; updateUnitSpatial(u);
            u.unitLevel = 1 + (k % 2) * 19; if (typeof u.updateStats === 'function') u.updateStats();
        }
    })()`));
    await page.waitForTimeout(1200);
    const center = async (zoom) => page.evaluate(z => { camera.zoom = z; camera.x = WORLD_W / 2 - viewW / camera.zoom / 2; camera.y = WORLD_H / 2 - viewH / camera.zoom / 2; clampCamera(); }, zoom);
    const shot = async name => { await page.waitForTimeout(700); await page.screenshot({ path: path.join(out, name + '.png') }); };
    // 1. Buttons.
    const buttons = await page.evaluate(() => ['btn-view-2d', 'btn-view-2d5', 'btn-view-3d', 'btn-view-3d5'].map(id => !!document.getElementById(id)));
    check('four view buttons', buttons.every(Boolean), buttons);
    for (const [id, mode] of [['btn-view-2d5', '2d.5'], ['btn-view-3d', '3d'], ['btn-view-3d5', '3d.5'], ['btn-view-2d', '2d']]) {
        await page.click('#' + id);
        await center(2.5);
        const st = await page.evaluate(() => ({ dim: renderDimensionMode, team: renderTeamColorsOnly, r3d: renderer3dInstance ? renderer3dInstance.teamColorsOnly : null,
            active: ['btn-view-2d', 'btn-view-2d5', 'btn-view-3d', 'btn-view-3d5'].filter(i => document.getElementById(i).classList.contains('active')) }));
        const want = { '2d.5': ['2d', true, 'btn-view-2d5'], '3d': ['3d', false, 'btn-view-3d'], '3d.5': ['3d', true, 'btn-view-3d5'], '2d': ['2d', false, 'btn-view-2d'] }[mode];
        check('button ' + id, st.dim === want[0] && st.team === want[1] && st.r3d === want[1] && st.active.length === 1 && st.active[0] === want[2], st);
        await shot('mode-' + id.replace('btn-view-', ''));
    }
    // 2. Space: short press toggles team colours, a held one the dimension.
    await page.click('#game-area', { position: { x: 700, y: 400 } }).catch(() => {});
    await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
    const mode = () => page.evaluate(() => renderDimensionMode + (renderTeamColorsOnly ? '.5' : ''));
    const m0 = await mode();
    await page.keyboard.down('Space'); await page.waitForTimeout(80); await page.keyboard.up('Space'); await page.waitForTimeout(300);
    const m1 = await mode();
    check('space short toggles team colours', m1 === (m0.endsWith('.5') ? m0.slice(0, 2) : m0 + '.5'), [m0, m1]);
    await page.keyboard.down('Space'); await page.waitForTimeout(650); const mHeld = await mode(); await page.keyboard.up('Space'); await page.waitForTimeout(300);
    const m2 = await mode();
    check('space held switches 2D/3D at once, keeps team colours', mHeld === m2 && m2.slice(0, 2) !== m1.slice(0, 2) && m2.endsWith('.5') === m1.endsWith('.5'), [m1, mHeld, m2]);
    // 3. Camera past the edges (half a view).
    const cam = await page.evaluate(() => { camera.zoom = 2; camera.x = -1e6; camera.y = -1e6; clampCamera(); const a = { x: camera.x, y: camera.y };
        camera.x = 1e9; camera.y = 1e9; clampCamera(); const b = { x: camera.x, y: camera.y }; const vw = viewW / camera.zoom, vh = viewH / camera.zoom;
        return { a, b, vw, vh, W: WORLD_W, H: WORLD_H }; });
    check('camera reaches half a view past each edge', Math.abs(cam.a.x + cam.vw / 2) < 1e-6 && Math.abs(cam.a.y + cam.vh / 2) < 1e-6
        && Math.abs(cam.b.x - (cam.W - cam.vw / 2)) < 1e-6 && Math.abs(cam.b.y - (cam.H - cam.vh / 2)) < 1e-6, cam);
    await page.evaluate(() => { camera.zoom = 1.2; camera.x = -viewW / camera.zoom / 2; camera.y = -viewH / camera.zoom / 2; clampCamera(); });
    await shot('camera-corner');
    // 4. Base model heights: a level 20 unit's model as tall as a level 1 one of its type.
    const heights = await page.evaluate(() => {
        const out = {};
        for (const u of units) { if (!u || u.dead || u.owner !== 0) continue; const k = u.unitType; const lv = u.unitLevel || u.effectiveLevel || 1;
            const h = _renderBaseVisionTiles({ visibilitySource: u, modelKey: 'unit_' + k }); (out[k] ||= {})[lv >= 10 ? 'high' : 'low'] = h; }
        return out; });
    check('model height by base sight, not level', Object.values(heights).every(v => v.high === undefined || v.low === undefined || v.high === v.low), heights);
    // 5. 3D: own and enemy units the player sees, readable on screen, both
    // get detail models. (Only the seen ones: enemies in the fog are hidden
    // (flag 1024) or remembered glyphs (65536) by design. The 4M case, slots
    // past 2^21, is tests/frame-order-slots.test.cjs.) The camera on the
    // two groups' middle, wherever they walked to.
    await page.click('#btn-view-3d');
    const mid = await page.evaluate(() => { const F = simClientCurrentUnitVis(); let x = 0, y = 0, n = 0;
        for (let s = 0; s < F.n; s++) if (F.id[s] >= 0 && F.energy[s] > 0 && !(F.flags[s] & (1024 | 65536))) { x += F.x[s]; y += F.y[s]; n++; }
        return n ? { x: x / n, y: y / n } : { x: WORLD_W / 2, y: WORLD_H / 2 }; });
    await page.evaluate(([z, x, y]) => { camera.zoom = z; camera.x = x - viewW / camera.zoom / 2; camera.y = y - viewH / camera.zoom / 2; clampCamera(); }, [3, mid.x, mid.y]);
    await page.waitForTimeout(2500);
    const det = await page.evaluate(() => {
        const F = simClientCurrentUnitVis(), mask = typeof _detailMask !== 'undefined' ? _detailMask : null, r = { own: [0, 0], enemy: [0, 0] };
        if (!F || !mask) return { error: 'no frame/mask' };
        for (let s = 0; s < F.n; s++) { if (F.id[s] < 0 || F.energy[s] <= 0 || (F.flags[s] & (1024 | 65536))) continue; const k = F.owner[s] === localPlayerId ? 'own' : 'enemy';
            const x = F.x[s] / TILE, z = F.y[s] / TILE, size = Math.max(.28, Math.min(.9, F.r[s] * 2.2 / TILE));
            if (!fullVisibility && k === 'enemy' && !(visibilityGrid[Math.floor(z)]?.[Math.floor(x)] > 0)) continue;
            if (!(_detailScore(x, z, size, false, false, 24) > 0)) continue;
            r[k][0]++; if (mask[s]) r[k][1]++; }
        return r; });
    check('seen enemy units get detail models like own ones', !det.error && det.own[0] > 0 && (fullVisibilityRun ? det.enemy[0] > 0 : true)
        && (det.enemy[0] === 0 || det.enemy[1] / det.enemy[0] >= 0.8 * det.own[1] / det.own[0]), det);
    await shot('3d-near-own-vs-enemy');
    await page.click('#btn-view-3d5'); await page.waitForTimeout(800); await shot('3d5-near');
    await page.click('#btn-view-2d'); await center(0.25); await shot('2d-far');
    await page.click('#btn-view-2d5'); await shot('2d5-far');
    check('no page errors', errors.length === 0, errors.slice(0, 5));
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors }, null, 1));
    await browser.close(); server.close();
    process.exit(Object.values(results).every(r => r.ok) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
