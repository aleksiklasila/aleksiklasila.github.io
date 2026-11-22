// The 3D facing of every unit as the page draws it, in Microsoft Edge, on a
// scene loaded through the game's own Load button (#input-import-snapshot):
// per presentation frame (a new tick drawn), each unit's facing (the frame's
// F.facing, what renderer3d turns the model by); a wiggle is a turn of more
// than WIG rad (0.3) followed at the next frame by one the other way of more
// than WIG. Reports wiggles per 1000 unit-frames and the units with most.
// Stuck units in a crowd spun back and forth (2026-11-21).
//   NODE_PATH=<dir with playwright> node tests/facing-jitter-edge-probe.cjs [scene.gz]
//   env: SECS (20), WIG (0.3), BASELINE=<git rev> (its src/ and index.html), HEADED=1, CAM=gx,gy,zoom
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm' };
const REF = process.env.BASELINE || '', refCache = new Map();
const refPrefix = REF ? require('node:child_process').execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: root, encoding: 'utf8' }).trim() : '';
const readSource = (name, file, done) => {
    if (REF && (name.startsWith('src/') || name === 'index.html')) {
        try { if (!refCache.has(name)) refCache.set(name, require('node:child_process').execFileSync('git', ['show', REF + ':' + refPrefix + name], { cwd: root, maxBuffer: 64e6 })); done(null, refCache.get(name)); } catch (e) { done(e); }
    } else fs.readFile(file, done);
};
const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html';
    const file = path.resolve(root, name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    readSource(name, file, (err, data) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store',
            'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
        res.end(data);
    });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SECS = Number(process.env.SECS) || 20, WIG = Number(process.env.WIG) || 0.3;
const scene = path.resolve(process.argv[2] || path.join(__dirname, 'defence3-scene-2026-11-21T13-39-07-046Z.gz'));
const CAM = (process.env.CAM || '82,18,1.6').split(',').map(Number);

const PAGE_START = ([wig, cam]) => {
    setRenderDimensionMode('3d');
    camera.zoom = cam[2];
    camera.x = cam[0] * TILE - viewW / camera.zoom / 2; camera.y = cam[1] * TILE - viewH / camera.zoom / 2;
    const R = window.__fj = { on: true, frames: 0, unitFrames: 0, wiggles: 0, last: new Map(), by: new Map(), lastTick: -1 };
    const render = processRenderFrame;
    window.processRenderFrame = function (ts) {
        const r = render.apply(this, arguments);
        const c = _simClient, F = simClientCurrentUnitVis(), tick = c ? (c.presentation ? c.presentationTick : c.appliedTick) : -1;
        if (R.on && F && tick !== R.lastTick) {
            R.lastTick = tick; R.frames++;
            for (const [id, v] of _pageUnitsById) {
                if (!v || v.dead || !(v._s >= 0)) continue;
                const a = F.facing[v._s], L = R.last.get(id);
                if (L) {
                    let d = a - L[0]; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
                    R.unitFrames++;
                    if (Math.abs(d) > wig && Math.abs(L[1]) > wig && Math.sign(d) !== Math.sign(L[1])) { R.wiggles++; R.by.set(id, (R.by.get(id) || 0) + 1); }
                    L[0] = a; L[1] = d;
                } else R.last.set(id, [a, 0]);
            }
        }
        return r;
    };
    return { mode: renderDimensionMode, units: _pageUnitsById.size };
};

let browser;
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 300)));
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(1000);
    await page.setInputFiles('#input-import-snapshot', scene);
    await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 40, {}, { timeout: 300000 });
    await page.waitForTimeout(1500);
    const info = await page.evaluate(PAGE_START, [WIG, CAM]);
    await sleep(SECS * 1000);
    const R = await page.evaluate(() => { const R = window.__fj; R.on = false; return { frames: R.frames, unitFrames: R.unitFrames, wiggles: R.wiggles, top: [...R.by].sort((a, b) => b[1] - a[1]).slice(0, 8) }; });
    const stats = await page.evaluate(() => { const s = simClientStats(); return { appliedTick: s.appliedTick, presentation: s.presentation }; });
    console.log(JSON.stringify({ scene: path.basename(scene), baseline: REF || null, secs: SECS, wig: WIG, ...info, ...stats, ...R,
        wigglesPer1000UnitFrames: R.unitFrames ? Math.round(R.wiggles / R.unitFrames * 1e5) / 100 : null, errors }, null, 1));
    await browser.close(); server.close();
})().catch(async e => { console.error(e); try { if (browser) await browser.close(); } catch {} server.close(); process.exit(1); });
