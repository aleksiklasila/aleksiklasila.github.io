// How one unit's motion and light are drawn, in Microsoft Edge: a builder
// ordered across the map on a diagonal, watched close up. Per drawn frame:
// where it is drawn (the frame's interpolation), the light of the tile under
// it and the unit's own; per tick, where the simulation has it. Reports the
// drawn speed's evenness (stalls, jumps, variation), the drawn path's
// sideways wobble against the straight line and against the simulation's own
// path, how often the heading flips, and the dips of the light it is drawn
// with. Run alone.
//   NODE_PATH=<dir with playwright> node tests/motion-jitter-probe.cjs [fixture]
//   env: MODE (3d | 2d), VIS (team | full | history), SECS (8), UNIT (worker
//        type to follow: builder), ZOOM (2), QUERY (page URL query), OUT (json),
//        DUMP=1 (every frame's row)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm' };
// (BASELINE=<git revision>: its sources, for a before/after on the same probe.)
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
const MODE = process.env.MODE === '2d' ? '2d' : '3d', VIS = process.env.VIS || 'team', SECS = Number(process.env.SECS) || 8;
const KIND = process.env.UNIT || 'builder', ZOOM = Number(process.env.ZOOM) || 2;
const fixture = (process.argv[2] || '1500.json').replace(/^(?!.*\.json$)(.*)$/, '$1.json');

// In the page: the unit, its order, the recorder.
const PAGE_START = ([kind, mode, zoom]) => {
    setRenderDimensionMode(mode);
    const F = simClientCurrentUnitVis();
    const mine = units.filter(u => u && !u.dead && u.owner === localPlayerId && (kind === 'any' ? !u.workerType : u.workerType === kind));
    if (!mine.length) return { error: 'no ' + kind + ' unit of the local player' };
    // (The one with the longest clear diagonal ahead: toward the map's far corner.)
    const W = GRID_W * TILE, H = GRID_H * TILE;
    const u = mine[0];
    const tx = u.x < W / 2 ? W * 0.85 : W * 0.15, ty = u.y < H / 2 ? H * 0.85 : H * 0.15;
    const R = window.__mj = { id: u.id, rows: [], on: true, from: [u.x, u.y], to: [tx, ty] };
    camera.zoom = zoom;
    const follow = () => { const v = _pageUnitsById.get(R.id); if (v && !v.dead) { camera.x = v.x - viewW / camera.zoom / 2; camera.y = v.y - viewH / camera.zoom / 2; } };
    follow();
    // (The light the detailed pass draws it with: the record it pushes.)
    const push = push3DRenderObject;
    window.push3DRenderObject = function (target, object) {
        const n = target ? target.length : 0, r = push.apply(this, arguments);
        if (R.on && object && target && target.length > n) { const src = object.pickSource || object.visibilitySource; if (src && src.id === R.id && src.unitType) R.drawn = target[target.length - 1].lightLevel; }
        return r;
    };
    // Where the 3D renderer draws it, from its own draw data: the unit
    // layer's record of it (its tick position and the way back to the one
    // before, drawn with the layer's alpha) or its per-frame object.
    const r3d = typeof renderer3dInstance !== 'undefined' ? renderer3dInstance : null;
    if (r3d && r3d.writeUnitLayerRecord) {
        const wr = r3d.writeUnitLayerRecord, wo = r3d.writeUnitLayerObject, rr = r3d.render;
        r3d.writeUnitLayerRecord = function (kind, mode, rec, panel, unit) { if (unit && unit.id === R.id) R.rec = [rec[12], rec[14], rec[3], rec[7]]; return wr.apply(this, arguments); };
        r3d.writeUnitLayerObject = function (o) { const src = o && o.pickSource; if (src && src.id === R.id) R.rec = [o.x, o.z, o._pdx, o._pdz]; return wo.apply(this, arguments); };
        r3d.render = function (snap) {
            R.layerAlpha = snap && snap.unitLayer ? snap.unitLayer.alpha : NaN; R.objPos = null;
            if (snap && snap.objects) for (const o of snap.objects) { const src = o.pickSource; if (src && src.id === R.id && src.unitType) { R.objPos = [o.x, o.z]; break; } }
            return rr.apply(this, arguments);
        };
    }
    const render = processRenderFrame;
    window.processRenderFrame = function (ts) {
        follow();
        R.drawn = -1;
        const r = render.apply(this, arguments);
        // What reached the screen: the unit's own pixels (its green body)
        // read back from the canvas around where it should be drawn: their
        // centre against that place (the camera follows the unit, so on the
        // screen it should stand still: whatever it moves by is jitter),
        // and how bright they are.
        let lum = -1, offX = NaN, offY = NaN, pix = 0;
        try {
            const r3 = renderer3dInstance, v0 = _pageUnitsById.get(R.id), F0 = simClientCurrentUnitVis(), s0 = v0 && !v0.dead ? v0._s : -1;
            if (R.on && r3 && r3.gl && F0 && s0 >= 0) {
                const a0 = tickAlpha, wx = F0.px[s0] + (F0.x[s0] - F0.px[s0]) * a0, wy = F0.py[s0] + (F0.y[s0] - F0.py[s0]) * a0;
                const p = r3.projectWorldToCanvas(wx / TILE, 0.05, wy / TILE), gl = r3.gl;
                if (p) {
                    const ratio = gl.drawingBufferWidth / r3.cssWidth, N = 121, buf = R.px || (R.px = new Uint8Array(N * N * 4));
                    const ex = p.x * ratio, ey = gl.drawingBufferHeight - p.y * ratio, x0 = Math.round(ex) - (N >> 1), y0 = Math.round(ey) - (N >> 1);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    gl.readPixels(x0, y0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, buf);
                    let sx = 0, sy = 0, sw = 0, sl = 0;
                    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                        const i = (y * N + x) * 4, r = buf[i], g = buf[i + 1], b = buf[i + 2];
                        // (Green over red and blue: the builder's body, not the ground or a ring.)
                        const w = g - Math.max(r, b) - 12;
                        if (w <= 0 || g < 40) continue;
                        sx += x * w; sy += y * w; sw += w; pix++;
                        const l = r * .299 + g * .587 + b * .114; if (l > sl) sl = l;
                    }
                    if (pix >= 12) { offX = x0 + sx / sw + 0.5 - ex; offY = -(y0 + sy / sw + 0.5 - ey); lum = sl; }
                }
            }
        } catch (e) { R.pxError = String(e.message || e); }
        if (R.on) {
            const v = _pageUnitsById.get(R.id), F = simClientCurrentUnitVis(), s = v && !v.dead ? v._s : -1;
            if (F && s >= 0) {
                const a = tickAlpha, x = F.px[s] + (F.x[s] - F.px[s]) * a, y = F.py[s] + (F.y[s] - F.py[s]) * a;
                const gx = Math.floor(F.x[s] / TILE), gy = Math.floor(F.y[s] / TILE);
                const lit = fullVisibility ? -1 : ((visibilityGrid[gy] && visibilityGrid[gy][gx]) || 0);
                const c = _simClient;
                R.rows.push([ts, a, c.presentation ? c.presentationTick : c.appliedTick, x, y, F.x[s], F.y[s], lit, F.light[s], F.vision[s], getAreaIdAtTile(gx, gy), F.facing[s], performance.now(), R.drawn, lum, offX, offY, pix,
                    // (The renderer's own position for it, in pixels of the world: its object, else its layer record.)
                    R.objPos ? R.objPos[0] * TILE : R.rec && R.layerAlpha === R.layerAlpha ? (R.rec[0] + R.rec[2] * (1 - R.layerAlpha)) * TILE : NaN,
                    R.objPos ? R.objPos[1] * TILE : R.rec && R.layerAlpha === R.layerAlpha ? (R.rec[1] + R.rec[3] * (1 - R.layerAlpha)) * TILE : NaN,
                    R.objPos ? 1 : 0]);
            }
        }
        return r;
    };
    selectedUnits = []; selectedEntities = [];
    queueAction({ action: 'move', unitIds: [u.id], targetX: tx, targetY: ty });
    return { id: u.id, type: u.unitType, from: R.from, to: R.to, vision: F ? F.vision[u._s] : null, light: F ? F.light[u._s] : null, full: fullVisibility, mode: renderDimensionMode,
        lightNorm: VISIBILITY_LIGHT_NORMALIZATION_RANGE, tickMs: TICK_MS };
};
// In the simulation worker: the unit's position at each tick's end.
const WORKER_START = id => `(() => {
    const T = self.__mjw = { id: ${id}, rows: [] };
    const tick = gameTick;
    gameTick = function () { const r = tick.apply(this, arguments); const u = getUnitById(T.id); if (u && !u.dead) T.rows.push([currentTick, u.x, u.y]); return r; };
    return 1; })()`;

function analyse(rows, sim, info) {
    const q = (a, p) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
    const r3 = v => Math.round(v * 1000) / 1000;
    // (From the first frame it moves to the last.)
    let first = rows.findIndex((r, i) => i > 0 && Math.hypot(r[3] - rows[i - 1][3], r[4] - rows[i - 1][4]) > 0.02);
    let last = rows.length - 1; while (last > first && Math.hypot(rows[last][3] - rows[last - 1][3], rows[last][4] - rows[last - 1][4]) <= 0.02) last--;
    const M = rows.slice(Math.max(0, first), last + 1);
    if (M.length < 30) return { error: 'the unit hardly moved', frames: rows.length };
    // Drawn speed per frame (px per ms), against its median.
    const sp = [], dts = [];
    for (let i = 1; i < M.length; i++) { const dt = M[i][0] - M[i - 1][0]; if (dt > 0) { sp.push(Math.hypot(M[i][3] - M[i - 1][3], M[i][4] - M[i - 1][4]) / dt); dts.push(dt); } }
    const med = q(sp, .5), mean = sp.reduce((a, b) => a + b, 0) / sp.length;
    const sd = Math.sqrt(sp.reduce((a, b) => a + (b - mean) * (b - mean), 0) / sp.length);
    // Sideways: the drawn path against the straight line from its start to
    // its end, and its frame-to-frame turning.
    const ax = M[0][3], ay = M[0][4], bx = M[M.length - 1][3], by = M[M.length - 1][4], L = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / L, ny = (bx - ax) / L;
    const side = M.map(r => (r[3] - ax) * nx + (r[4] - ay) * ny);
    // (The wobble: what a 9-frame moving average of the sideways offset leaves.)
    const wob = [];
    for (let i = 4; i + 4 < side.length; i++) { let m = 0; for (let k = -4; k <= 4; k++) m += side[i + k]; wob.push(side[i] - m / 9); }
    const rms = a => Math.sqrt(a.reduce((x, y) => x + y * y, 0) / Math.max(1, a.length));
    let turns = 0, steps = 0, back = 0;
    for (let i = 2; i < M.length; i++) {
        const dx = M[i][3] - M[i - 1][3], dy = M[i][4] - M[i - 1][4], ex = M[i - 1][3] - M[i - 2][3], ey = M[i - 1][4] - M[i - 2][4];
        const m = Math.hypot(dx, dy), m0 = Math.hypot(ex, ey);
        if (m < 0.02 || m0 < 0.02) continue;
        steps++;
        const cos = (dx * ex + dy * ey) / (m * m0);
        if (cos < Math.cos(20 * Math.PI / 180)) turns++;
        if (cos < 0) back++;
    }
    // The heading it is drawn with (frame's facing): flips per second.
    let flips = 0; for (let i = 1; i < M.length; i++) { let d = M[i][11] - M[i - 1][11]; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; if (Math.abs(d) > 0.35) flips++; }
    // The simulation's own path, per tick.
    const S = sim.filter(r => r[0] >= M[0][2] - 1 && r[0] <= M[M.length - 1][2] + 1);
    const sstep = [], sside = [];
    for (let i = 1; i < S.length; i++) sstep.push(Math.hypot(S[i][1] - S[i - 1][1], S[i][2] - S[i - 1][2]));
    for (const r of S) sside.push((r[1] - ax) * nx + (r[2] - ay) * ny);
    const swob = []; for (let i = 2; i + 2 < sside.length; i++) swob.push(sside[i] - (sside[i - 2] + sside[i - 1] + sside[i] + sside[i + 1] + sside[i + 2]) / 5);
    let sturn = 0; for (let i = 2; i < S.length; i++) { const dx = S[i][1] - S[i - 1][1], dy = S[i][2] - S[i - 1][2], ex = S[i - 1][1] - S[i - 2][1], ey = S[i - 1][2] - S[i - 2][2]; const m = Math.hypot(dx, dy), m0 = Math.hypot(ex, ey); if (m > .05 && m0 > .05 && (dx * ex + dy * ey) / (m * m0) < Math.cos(20 * Math.PI / 180)) sturn++; }
    const sm = sstep.length ? sstep.reduce((a, b) => a + b, 0) / sstep.length : 0;
    // The light it is drawn with: the tile's, or its own when that is more
    // (the detailed pass's rule), over the normalization range.
    // (As the detailed pass drew it, when it did: -1 otherwise, the glyphs' shader.)
    const det = M.filter(r => r[13] >= 0).map(r => r[13]);
    const light = det.length ? det : [1], tile = M.map(r => r[7] < 0 ? 1 : r[7] / info.lightNorm);
    // The unit on the screen against where it should be (the camera follows
    // it): the offset of its pixels' centre, less its slow part (a moving
    // median of 15 frames: the model's own sway), is what jitters. Along the
    // way it goes on the screen: steps back and forth from frame to frame.
    const scr = M.filter(r => r[15] === r[15]);
    let screenJitter = null;
    if (scr.length > 60) {
        const medOf = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
        const ox = scr.map(r => r[15]), oy = scr.map(r => r[16]), rx = [], ry = [];
        for (let i = 7; i + 7 < scr.length; i++) { rx.push(ox[i] - medOf(ox.slice(i - 7, i + 8))); ry.push(oy[i] - medOf(oy.slice(i - 7, i + 8))); }
        const mag = rx.map((v, i) => Math.hypot(v, ry[i]));
        // (The screen direction of travel: of the drawn world path.)
        const wdx = M[M.length - 1][3] - M[0][3], wdy = M[M.length - 1][4] - M[0][4], wl = Math.hypot(wdx, wdy) || 1;
        const along = rx.map((v, i) => v * (wdx / wl) + ry[i] * (-wdy / wl));
        let flips = 0, big = 0;
        for (let i = 2; i < along.length; i++) { const d1 = along[i] - along[i - 1], d0 = along[i - 1] - along[i - 2]; if (Math.abs(d1) > 0.25 && Math.abs(d0) > 0.25 && d1 * d0 < 0) flips++; if (Math.abs(d1) > 1) big++; }
        screenJitter = { frames: scr.length, rmsPx: r3(rms(mag)), p95Px: r3(q(mag, .95)), maxPx: r3(Math.max(...mag)), backForthPer100Frames: r3(flips / along.length * 100), stepsOver1PxPer100Frames: r3(big / along.length * 100),
            pixels: medOf(scr.map(r => r[17])) };
    }
    // The 3D renderer's own position for it against the frame's interpolation
    // (what it should draw): how far off, and its steps along the way (a step
    // back is the unit drawn moving backwards).
    const drw = M.filter(r => r[18] === r[18]);
    let drawn3d = null;
    if (drw.length > 60) {
        const dev = drw.map(r => Math.hypot(r[18] - r[3], r[19] - r[4]));
        const ux = (M[M.length - 1][3] - M[0][3]), uy = (M[M.length - 1][4] - M[0][4]), ul = Math.hypot(ux, uy) || 1;
        let backSteps = 0, fwd = [];
        for (let i = 1; i < drw.length; i++) { const st = ((drw[i][18] - drw[i - 1][18]) * ux + (drw[i][19] - drw[i - 1][19]) * uy) / ul; if (st < -0.05) backSteps++; fwd.push(st); }
        const fm = q(fwd, .5);
        drawn3d = { frames: drw.length, perFrameObject: drw.filter(r => r[20] === 1).length, offRmsPx: r3(rms(dev)), offMaxPx: r3(Math.max(...dev)), framesOffOverHalfPx: dev.filter(v => v > 0.5).length,
            backStepsPer100Frames: r3(backSteps / drw.length * 100), stepMedianPx: r3(fm), stepP5: r3(q(fwd, .05)), stepP95: r3(q(fwd, .95)) };
    }
    // The unit on the screen: its brightest pixel, against its median.
    const lum = M.map(r => r[14]).filter(v => v >= 0), lumMed = q(lum, .5);
    let lumDips = 0, lumLow = 0, inLow = false;
    for (const v of lum) { const low = v < lumMed * 0.8; if (low && !inLow) lumDips++; inLow = low; if (low) lumLow++; }
    const lmed = q(tile, .5);
    let dips = 0, deep = 0, dark = 0, inDip = false, areas = 0;
    for (let i = 0; i < tile.length; i++) {
        const low = tile[i] < lmed * 0.7;
        if (low && !inDip) dips++;
        inDip = low;
        if (tile[i] <= 0) dark++;
        if (tile[i] < lmed * 0.4) deep++;
        if (i > 0 && M[i][10] !== M[i - 1][10]) areas++;
    }
    return { frames: M.length, seconds: r3((M[M.length - 1][0] - M[0][0]) / 1000), frameMs: { p50: r3(q(dts, .5)), p95: r3(q(dts, .95)) },
        speed: { medianPxPerS: r3(med * 1000), cv: r3(sd / (mean || 1)), stallPct: r3(sp.filter(v => v < med * 0.5).length / sp.length * 100), jumpPct: r3(sp.filter(v => v > med * 1.5).length / sp.length * 100),
            p5: r3(q(sp, .05) / (med || 1)), p95: r3(q(sp, .95) / (med || 1)) },
        path: { wobbleRmsPx: r3(rms(wob)), wobbleMaxPx: r3(Math.max(0, ...wob.map(Math.abs))), turnsOver20degPct: r3(turns / Math.max(1, steps) * 100), backPct: r3(back / Math.max(1, steps) * 100), facingFlipsPerS: r3(flips / ((M[M.length - 1][0] - M[0][0]) / 1000)) },
        sim: { ticks: S.length, stepPx: r3(sm), stepCv: r3(sm ? Math.sqrt(sstep.reduce((a, b) => a + (b - sm) * (b - sm), 0) / sstep.length) / sm : 0), wobbleRmsPx: r3(rms(swob)), turnsOver20degPct: r3(sturn / Math.max(1, S.length - 2) * 100) },
        screen: screenJitter, drawn3d,
        light: { tileMedian: r3(lmed), tileMin: r3(Math.min(...tile)), drawnMin: r3(Math.min(...light)), drawnMax: r3(Math.max(...light)), drawnFrames: det.length, dips: dips, framesUnder40pct: deep, framesDark: dark, areaCrossings: areas, own: r3(M[0][8] / info.lightNorm), vision: M[0][9],
            screen: { median: r3(lumMed), min: r3(lum.length ? Math.min(...lum) : -1), p5: r3(q(lum, .05)), dipsUnder80pct: lumDips, framesUnder80pct: lumLow, frames: lum.length } } };
}

let browser;
(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    browser = await chromium.launch({ channel: 'msedge', headless: !process.env.HEADED,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 300)));
    const qs = process.env.QUERY ? '?' + process.env.QUERY : '';
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html${qs}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForTimeout(1000);
    await page.evaluate(async ([fixture, vis]) => {
        const data = await (await fetch('tests/' + fixture)).json();
        applyMainMenuSettingsSnapshot(data);
        document.getElementById('cfg-full-vis').value = vis;
        const now = Date.now; Date.now = () => 1790000000000;
        try { startSoloGame(); } finally { Date.now = now; }
    }, [fixture, VIS]);
    await page.waitForFunction(() => typeof simClientStats === 'function' && simClientStats().appliedTick >= 40, {}, { timeout: 300000 });
    await page.waitForTimeout(1500);
    const info = await page.evaluate(PAGE_START, [KIND, MODE, ZOOM]);
    if (info.error) throw new Error(info.error);
    await page.evaluate(expr => simClientRequest('debugEval', { expr }), WORKER_START(info.id));
    await sleep(SECS * 1000);
    const rows = await page.evaluate(() => { window.__mj.on = false; return window.__mj.rows; });
    const play = await page.evaluate(() => { const P = typeof _simClient !== 'undefined' && _simClient && _simClient.play; return P ? { stalls: P.stalls, snaps: P.snaps, want: Math.round(P.want * 100) / 100, periodMs: Math.round(P.period * 10) / 10, gap: Math.round(P.gap * 100) / 100, jitMs: Math.round(P.jit * 10) / 10, rate: Math.round(P.rate * 1000) / 1000, queued: P.queue.length } : null; });
    const sim = JSON.parse(await page.evaluate(() => simClientRequest('debugEval', { expr: 'self.__mjw.rows' })));
    const result = analyse(rows, sim, info);
    const out = { fixture, mode: MODE, vis: VIS, zoom: ZOOM, unit: info, result, play, errors };
    console.log(JSON.stringify(out, null, 1));
    if (process.env.DUMP) for (const r of rows) console.log(r.map(v => Math.round(v * 100) / 100).join(' '));
    if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ ...out, rows, sim }) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); server.close(); });
