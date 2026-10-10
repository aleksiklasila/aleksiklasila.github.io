// Nothing drawn may flicker: in the real renderer (Edge, WebGL2), every
// structure and unit drawn on the frames around a frame must be drawn on
// that frame too (no one-frame gaps), and nothing may appear for one frame
// only. Frames between ticks reuse the layers built on tick frames (the
// unit layer, the structure layer); this checks those reuse paths against
// the frames that build them, with the game running normally.
// Units must also move continuously: the tick interpolation has to advance
// between ticks (not hold units at their previous tick, then jump), and a
// unit's drawn position may not step back and forth.
// Skipped when Edge is not installed (set EDGE to another Chromium).
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };

function serve() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        let file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
        if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
        if (file === root) file = path.join(root, 'index.html');
        fs.readFile(file, (err, data) => {
            if (err) { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
            res.end(data);
        });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r(server)));
}

async function browser(url) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'defence-frames-'));
    const port = 9800 + Math.floor(Math.random() * 150);
    const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--window-size=1600,1000', '--disable-features=CalculateNativeWinOcclusion', 'about:blank'], { stdio: 'ignore', windowsHide:true });
    let page;
    for (let i = 0; i < 100 && !page; i++) {
        try { page = (await (await fetch(`http://127.0.0.1:${port}/json`, {signal:AbortSignal.timeout(1000)})).json()).find(t => t.type === 'page'); } catch {}
        if (!page) await sleep(200);
    }
    if (!page) { proc.kill(); throw new Error('Edge debug endpoint did not open'); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    let id = 0; const pending = new Map();
    ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p=pending.get(d.id); clearTimeout(p.timer); p.resolve(d); pending.delete(d.id); } };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const i = ++id;
        const timer = setTimeout(() => { pending.delete(i); reject(new Error('CDP timeout: '+method+' '+String(params.expression||'').slice(0,120))); }, 30000);
        pending.set(i,{resolve,reject,timer}); ws.send(JSON.stringify({ id:i,method,params }));
    });
    ws.onclose = () => { for(const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Edge connection closed')); } pending.clear(); };
    const ev = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
        return r.result.result.value;
    };
    await send('Page.enable');
    await send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) { await sleep(200); try { if (await ev(`typeof applyMainMenuSettingsSnapshot === 'function' && document.readyState === 'complete'`)) break; } catch {} }
    // Edge runs as a tree of processes: ask the browser to exit, then make
    // sure the whole tree is gone (killing the launcher alone leaves it running).
    const close = async () => {
        try { await Promise.race([send('Browser.close'), sleep(2000)]); } catch {}
        try { ws.close(); } catch {}
        await sleep(300);
        if (process.platform === 'win32') { try { require('node:child_process').execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
        else { try { process.kill(-proc.pid); } catch {} try { proc.kill('SIGKILL'); } catch {} }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    };
    return { ev, close };
}

// Per frame: the structures (by entity) and units drawn, from the
// renderer's own draw lists (layers as drawn, plus the frame's objects).
const RECORD = `(async (ms) => {
    const r3 = renderer3dInstance, frames = [];
    const idOf = new Map(); let next = 1;
    const key = e => { let k = idOf.get(e); if (k === undefined) idOf.set(e, k = next++); return k; };
    const orig = r3.render;
    r3.render = function (snap) {
        const res = orig.apply(this, arguments);
        // (The scale path (far zoom, big matches): instanced layers, or the
        // frame's columns; counted, not tracked per entity.)
        if (snap.scaleLayers) {
            const C = snap.columnLayers, L = snap.scaleLayers;
            frames.push({ tick: gameTime, alpha: tickAlpha, structures: [], units: [], pos: [],
                scale: [C ? (C.structureSources ? C.structureSources.length : 0) : (L[0] ? L[0].count : 0), C ? (C.unitSources ? C.unitSources.length : 0) : (L[1] ? L[1].count : 0)] });
            return res;
        }
        const structures = new Set(), unitsDrawn = new Set();
        const add = o => { const s = o && o.pickSource; if (!s) return; if (s.unitType && units.includes(s)) unitsDrawn.add(key(s)); else structures.add(key(s)); };
        for (const o of snap.objects || []) add(o);
        if (snap.staticLayer && this.staticGroups) for (const o of snap.staticLayer.objects || []) add(o);
        if (snap.unitLayer) {
            for (const o of this.unitLayerObjects || []) add(o);
            for (const rp of this.unitLayerRecordPicks || []) for (let i = 0; i < rp.units.length; i += 2) unitsDrawn.add(key(rp.units[i]));
        }
        // The bounded layers hand their other entities to the GPU column
        // pass (including its instanced middle models). Track that ownership
        // as well; a LOD promotion is not an entity disappearing.
        const columns=snap.columnLayers;
        if(columns) {
            if(columns.units)for(const entity of columns.unitSources||[])if(entity&&!entity.dead)unitsDrawn.add(key(entity));
            if(columns.structures)for(const entity of columns.structureSources||[])if(entity&&!entity.dead)structures.add(key(entity));
        }
        // Drawn positions of the first moving units (records and alpha).
        const vis = typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
        const a = snap.unitLayer ? snap.unitLayer.alpha : tickAlpha;
        const pos = [];
        for (let i = 0, n = 0; i < units.length && n < 60; i++) {
            const u = units[i];
            if (u.owner !== localPlayerId || u.workerType) continue;
            n++;
            let x, y, px, py;
            // (With the worker, units read the frame the renderer draws from.)
            x = u.x; y = u.y; px = u.prevX; py = u.prevY;
            pos.push([key(u), px + (x - px) * a, py + (y - py) * a]);
        }
        frames.push({ tick: gameTime, alpha: a, structures: [...structures], units: [...unitsDrawn], pos });
        return res;
    };
    await new Promise(r => setTimeout(r, ms));
    r3.render = orig;
    return JSON.stringify(frames);
})`;

// Interpolation and drawn unit motion.
function motion(frames) {
    let between = 0, alphaBack = 0, steps = 0, back = 0;
    for (let f = 0; f < frames.length; f++) {
        const a = frames[f].alpha;
        if (a > 0.05 && a < 0.95) between++;
        if (f > 0 && frames[f].tick === frames[f - 1].tick && a < frames[f - 1].alpha - 1e-6) alphaBack++;
        if (f < 2) continue;
        const at = new Map(frames[f - 1].pos.map(p => [p[0], p])), at2 = new Map(frames[f - 2].pos.map(p => [p[0], p]));
        for (const p of frames[f].pos) {
            const q = at.get(p[0]), r = at2.get(p[0]);
            if (!q || !r) continue;
            const dx = p[1] - q[1], dy = p[2] - q[2], ex = q[1] - r[1], ey = q[2] - r[2];
            const m = Math.hypot(dx, dy), m0 = Math.hypot(ex, ey);
            if (m < 0.05 || m0 < 0.05) continue;
            steps++;
            if ((dx * ex + dy * ey) / (m * m0) < -0.5) back++;
        }
    }
    return { between: between / frames.length, alphaBack, steps, backRate: back / Math.max(1, steps) };
}

function flickers(frames, field) {
    // x drawn in frames f-1 and f+1 but not f (a gap), or only in f (a pop).
    const sets = frames.map(f => new Set(f[field]));
    let gaps = 0, pops = 0, example = null;
    for (let f = 1; f + 1 < sets.length; f++) {
        for (const x of sets[f - 1]) if (!sets[f].has(x) && sets[f + 1].has(x)) { gaps++; example = example || { f, x, kind: 'gap', ticks: [frames[f - 1].tick, frames[f].tick, frames[f + 1].tick] }; }
        for (const x of sets[f]) if (!sets[f - 1].has(x) && !sets[f + 1].has(x)) { pops++; example = example || { f, x, kind: 'pop', ticks: [frames[f - 1].tick, frames[f].tick, frames[f + 1].tick] }; }
    }
    return { gaps, pops, example };
}

(async () => {
    if (!fs.existsSync(EDGE)) { console.log('render-frame-stability: skipped (no Edge at ' + EDGE + ')'); return; }
    const server = await serve();
    const port = server.address().port;
    const b = await browser(`http://127.0.0.1:${port}/index.html`);
    try {
        await b.ev(`(async () => {
            const data = await (await fetch('tests/1500.json')).json();
            applyMainMenuSettingsSnapshot(data);
            { const dn = Date.now; Date.now = () => 1234567; try { [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Play Solo').click(); } finally { Date.now = dn; } }
            await new Promise(r => setTimeout(r, 3000));
            setRenderDimensionMode('3d');
            const mine = units.filter(u => !u.dead && u.owner === localPlayerId && !u.workerType);
            for (let i = 0; i < 10; i++) queueAction({ action: 'move', unitIds: mine.filter((u, k) => k % 10 === i).map(u => u.id),
                targetX: (0.15 + 0.7 * ((i * 7) % 10) / 9) * GRID_W * TILE, targetY: (0.15 + 0.7 * ((i * 3) % 10) / 9) * GRID_H * TILE });
            return 1;
        })()`);
        // Full zoom-out uses the same columns and model layers as close views.
        {
            const frames = JSON.parse(await b.ev(`(async () => {
                camera.zoom = getMinCameraZoom(); camera.x = GRID_W * TILE * .5 - viewW / camera.zoom / 2; camera.y = GRID_H * TILE * .5 - viewH / camera.zoom / 2;
                await new Promise(r => setTimeout(r, 1500));
                return ${RECORD}(2000);
            })()`));
            assert.ok(frames.length > 30 && frames.every(f=>!f.scale), 'zoom-out never switches render pipelines');
            assert.ok(frames.every(f => f.structures.length > 100 && f.units.length > 100), 'the scene is drawn on every far frame');
        }
        // The same layers remain complete through closer zoom levels.
        for (const zoom of ['getMinCameraZoom()', '1.5']) {
            const frames = JSON.parse(await b.ev(`(async () => {
                camera.zoom = ${zoom}; camera.x = GRID_W * TILE * .5 - viewW / camera.zoom / 2; camera.y = GRID_H * TILE * .5 - viewH / camera.zoom / 2;
                await new Promise(r => setTimeout(r, 1500));
                return ${RECORD}(3000);
            })()`));
            const ticks = new Set(frames.map(f => f.tick)).size;
            const s = flickers(frames, 'structures'), u = flickers(frames, 'units');
            const drawn = frames.reduce((a, f) => a + f.structures.length, 0) / frames.length;
            const drawnUnits = frames.reduce((a, f) => a + f.units.length, 0) / frames.length;
            console.log(`zoom ${zoom}: ${frames.length} frames over ${ticks} ticks, ~${drawn | 0} structures, ~${drawnUnits | 0} units drawn; structures`, JSON.stringify(s), 'units', JSON.stringify(u));
            assert.ok(frames.length > 60 && ticks > 10, 'frames recorded across ticks');
            assert.ok(drawn > 100 && drawnUnits > 100, 'the scene is drawn');
            assert.equal(s.gaps + s.pops, 0, `structures flicker: ${JSON.stringify(s.example)}`);
            assert.equal(u.gaps + u.pops, 0, `units flicker: ${JSON.stringify(u.example)}`);
            const m = motion(frames);
            console.log('  motion', JSON.stringify(m));
            assert.ok(m.between > 0.3, `units must be interpolated between ticks (alpha strictly between 0 and 1 on ${(m.between * 100).toFixed(0)}% of frames)`);
            assert.equal(m.alphaBack, 0, 'interpolation never runs backwards within a tick');
            assert.ok(m.steps > 1000, 'units move while recorded');
            assert.ok(m.backRate < 0.01, `drawn units step back and forth: ${(m.backRate * 100).toFixed(2)}% of steps`);
        }
        // One unit given a new move order every 300 ms (as when a player keeps
        // clicking ahead of it): its drawn position must keep moving forward,
        // never hold then jump (a result that cuts the interpolation short)
        // nor step back, in 2D (the page's positions) and 3D (the records).
        for (const mode of ['2d', '3d']) {
            const r = JSON.parse(await b.ev(`(async () => {
                setRenderDimensionMode('${mode}');
                const k = units.find(u => !u.dead && u.owner === localPlayerId && u.isKing) || units.find(u => !u.dead && u.owner === localPlayerId && !u.workerType);
                camera.zoom = 2; camera.x = k.x - viewW / camera.zoom / 2; camera.y = k.y - viewH / camera.zoom / 2;
                await new Promise(r => setTimeout(r, 500));
                const ys = [];
                const orig = processRenderFrame;
                window.processRenderFrame = function () {
                    const res = orig.apply(this, arguments);
                    const i = units.indexOf(k), vis = typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
                    ys.push([k.prevY + (k.y - k.prevY) * tickAlpha, tickAlpha, performance.now()]);
                    return res;
                };
                for (let n = 0; n < 8; n++) {
                    queueAction({ action: 'move', unitIds: [k.id], targetX: k.x + ((n % 3) - 1) * 6, targetY: k.y - 90 });
                    await new Promise(r => setTimeout(r, 300));
                }
                window.processRenderFrame = orig;
                return JSON.stringify(ys);
            })()`));
            const ry = r.map(x => x[0]);
            // Reversals: consecutive steps in opposite directions (a path
            // may turn back; drawn motion may not flip frame to frame).
            let first = ry.findIndex((y, i) => i > 0 && Math.abs(y - ry[i - 1]) > 0.01), back = 0, holds = 0, steps = 0, starved = 0, last = 0;
            for (let i = Math.max(1, first + 1); i < ry.length; i++) {
                const dy = ry[i] - ry[i - 1];
                if (Math.abs(dy) <= 0.01) { holds++; if (r[i][1] >= 1) starved++; continue; }
                steps++;
                if (Math.abs(dy) > 0.05 && Math.abs(last) > 0.05 && Math.sign(dy) !== Math.sign(last)) back++;
                last = dy;
            }
            console.log(`  ${mode} repeated orders: ${steps} moving frames, ${holds} held (${starved} waiting for a late result), ${back} back`);
            if (process.env.DUMP_MOTION) console.log(r.map(x => x.map(v => +v.toFixed(2)).join(' ')).join(String.fromCharCode(10)));
            assert.ok(first >= 0 && steps > 40, `${mode}: the unit moves`);
            assert.ok(back <= 2, `${mode}: repeated orders make the unit jitter back and forth (${back} reversals)`);
            // Held while its result is due (not waiting for a late one): the
            // interpolation stopped short.
            // (The jump-then-hold bug held ~25% of frames; a loaded machine a few %.)
            assert.ok(holds - starved <= Math.max(3, steps * 0.12), `${mode}: the unit stalls between results (${holds - starved} held frames of ${steps + holds})`);
        }
        console.log('render-frame-stability: ok');
    } finally {
        await b.close();
        server.close();
    }
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 200));
