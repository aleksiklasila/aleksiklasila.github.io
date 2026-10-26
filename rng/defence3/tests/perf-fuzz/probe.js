// The perf fuzzer's probe, evaluated in the game page once a match runs
// (and again after every page load). Records frames, tick results,
// presentation frames, long tasks, input handler times and the cost of the
// page's render frame in preallocated rings (no allocation per event: the
// probe must not make GC pauses of its own), and answers window summaries
// and geometry questions for the fuzzer (Node side: tests/perf-fuzz.cjs).
// Every game global used here is looked up defensively: a renamed function
// switches one hook off, it does not break the run (see __pf.hooks).
(() => {
    'use strict';
    if (window.__pf && window.__pf.v === 1) return 'present';
    const P = window.__pf = { v: 1, hooks: {}, errors: [], marks: [], planted: {} };
    const now = () => performance.now();
    const note = (where, e) => { if (P.errors.length < 40) P.errors.push(where + ': ' + String(e && e.message || e).slice(0, 160)); };

    // ---- rings ----
    const NF = 1 << 16, NT = 1 << 14, NP = 1 << 15;
    const frameT = new Float64Array(NF); let frameN = 0;
    const workT = new Float64Array(NP), workD = new Float32Array(NP); let workN = 0;
    const tickT = new Float64Array(NT), tickK = new Float64Array(NT), tickSim = new Float32Array(NT), tickLate = new Float32Array(NT); let tickN = 0;
    const presT = new Float64Array(NT), presMs = new Float32Array(NT); let presN = 0;
    const longs = [], events = [];
    const KEEP_MS = 300000;
    const prune = list => { const cut = now() - KEEP_MS; let i = 0; while (i < list.length && list[i][0] < cut) i++; if (i) list.splice(0, i); };

    const onFrame = ts => { frameT[frameN++ & (NF - 1)] = ts; requestAnimationFrame(onFrame); };
    requestAnimationFrame(onFrame);
    try { new PerformanceObserver(list => { for (const e of list.getEntries()) longs.push([e.startTime, e.duration]); prune(longs); }).observe({ type: 'longtask', buffered: false }); } catch (e) { note('longtask', e); }
    // Input: from the event to the end of its handlers (the work the click itself costs).
    try { new PerformanceObserver(list => { for (const e of list.getEntries()) events.push([e.startTime, e.name, e.processingStart - e.startTime, e.processingEnd - e.processingStart, e.duration]); prune(events); }).observe({ type: 'event', durationThreshold: 16, buffered: false }); } catch (e) { note('event', e); }

    // ---- hooks into the game ----
    try {
        const apply = _simClientApplyTick;
        _simClientApplyTick = function (msg) {
            try { if (msg && msg.epoch === _simClient.epoch) { const i = tickN++ & (NT - 1); tickT[i] = now(); tickK[i] = Number(msg.tick) || 0; tickSim[i] = Number(msg.simMs) || 0; tickLate[i] = Number(msg.lateMs) || 0; } } catch (e) { }
            return apply.apply(this, arguments);
        };
        P.hooks.tick = true;
    } catch (e) { note('tick hook', e); }
    try {
        const onMsg = _simClientOnMessage;
        _simClientOnMessage = function (msg) {
            try { if (msg && msg.type === 'presentation') { const i = presN++ & (NT - 1); presT[i] = now(); presMs[i] = Number(msg.buildMs) || 0; } } catch (e) { }
            return onMsg.apply(this, arguments);
        };
        P.hooks.pres = true;
    } catch (e) { note('presentation hook', e); }
    try {
        const prf = processRenderFrame;
        processRenderFrame = function () { const a = now(); try { return prf.apply(this, arguments); } finally { const i = workN++ & (NP - 1); workT[i] = a; workD[i] = now() - a; } };
        P.hooks.work = true;
    } catch (e) { note('render frame hook', e); }

    // ---- window summaries ----
    const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
    const q = (a, p) => { if (!a.length) return 0; const b = Float64Array.from(a).sort(); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
    const ringTail = (T, N, cap, t0, t1, lead) => {
        // Indexes (oldest first) of entries with t0 - lead <= t <= t1.
        const out = []; const lo = Math.max(0, N - cap);
        for (let i = N - 1; i >= lo; i--) { const t = T[i & (cap - 1)]; if (t > t1) continue; if (t < t0 - (lead || 0)) break; out.push(i & (cap - 1)); }
        return out.reverse();
    };
    P.win = (t0, t1) => {
        const span = Math.max(1, t1 - t0), o = { ms: r1(span) };
        // frames: the frame before the window gives the first interval.
        const fi = ringTail(frameT, frameN, NF, t0, t1, 500), dts = [];
        let n = 0;
        for (let k = 1; k < fi.length; k++) { if (frameT[fi[k]] >= t0) { dts.push(frameT[fi[k]] - frameT[fi[k - 1]]); n++; } }
        const lastF = fi.length ? frameT[fi[fi.length - 1]] : t0;
        const trail = Math.max(0, t1 - lastF);
        if (trail > 40) dts.push(trail);
        o.fps = r1(n / (span / 1000));
        o.frame = { p50: r1(q(dts, .5)), p95: r1(q(dts, .95)), p99: r1(q(dts, .99)), max: r1(dts.length ? Math.max(...dts) : 0), over33: dts.filter(d => d > 33).length, over50: dts.filter(d => d > 50).length, over100: dts.filter(d => d > 100).length, over250: dts.filter(d => d > 250).length };
        // render-frame work (the page's own cost of a frame, not the GPU's)
        const wi = ringTail(workT, workN, NP, t0, t1, 0), wd = wi.map(i => workD[i]);
        o.work = { n: wd.length, mean: r2(wd.length ? wd.reduce((a, b) => a + b, 0) / wd.length : 0), p95: r2(q(wd, .95)), max: r2(wd.length ? Math.max(...wd) : 0) };
        // tick results: the one before the window gives the first interval.
        const ti = ringTail(tickT, tickN, NT, t0, t1, 1000);
        const first = ti.findIndex(i => tickT[i] >= t0), inWin = first >= 0 ? ti.slice(first) : [];
        if (inWin.length >= 2 || (inWin.length === 1 && first > 0)) {
            const b = first > 0 ? ti[first - 1] : inWin[0], e = inWin[inWin.length - 1];
            const dtk = tickK[e] - tickK[b], dtm = tickT[e] - tickT[b];
            o.tps = dtm > 0 ? r1(dtk / (dtm / 1000)) : 0;
            const gaps = []; for (let k = 1; k < ti.length; k++) { if (tickT[ti[k]] >= t0) gaps.push(tickT[ti[k]] - tickT[ti[k - 1]]); }
            const trailT = Math.max(0, t1 - tickT[e]);
            o.tick = { n: inWin.length, gapP50: r1(q(gaps, .5)), gapP95: r1(q(gaps, .95)), gapMax: r1(gaps.length ? Math.max(...gaps) : 0), trail: r1(trailT) };
            if (trailT > o.tick.gapMax) o.tick.gapMax = r1(trailT);
            const sim = inWin.map(i => tickSim[i]), late = inWin.map(i => tickLate[i]);
            o.sim = { mean: r2(sim.reduce((a, b) => a + b, 0) / sim.length), p95: r2(q(sim, .95)), max: r2(Math.max(...sim)) };
            o.late = { mean: r2(late.reduce((a, b) => a + b, 0) / late.length), p95: r2(q(late, .95)), max: r2(Math.max(...late)) };
        } else {
            o.tps = 0; o.tick = { n: 0, gapP50: 0, gapP95: 0, gapMax: r1(Math.min(span, ti.length ? t1 - tickT[ti[ti.length - 1]] : span)), trail: r1(span) };
            o.sim = { mean: 0, p95: 0, max: 0 }; o.late = { mean: 0, p95: 0, max: 0 };
        }
        const pi = ringTail(presT, presN, NT, t0, t1, 500), pg = [];
        for (let k = 1; k < pi.length; k++) if (presT[pi[k]] >= t0) pg.push(presT[pi[k]] - presT[pi[k - 1]]);
        o.pres = { n: pg.length, gapP95: r1(q(pg, .95)), gapMax: r1(pg.length ? Math.max(...pg) : 0), buildMs: r2(pi.length ? q(pi.map(i => presMs[i]), .5) : 0) };
        const lt = longs.filter(l => l[0] >= t0 && l[0] <= t1);
        o.long = { n: lt.length, ms: Math.round(lt.reduce((a, l) => a + l[1], 0)), max: Math.round(lt.length ? Math.max(...lt.map(l => l[1])) : 0) };
        const ev = events.filter(e => e[0] >= t0 && e[0] <= t1).sort((a, b) => b[3] - a[3]);
        o.input = { n: ev.length, handlerMax: Math.round(ev.length ? ev[0][3] : 0), delayMax: Math.round(ev.length ? Math.max(...ev.map(e => e[2])) : 0), worst: ev.slice(0, 3).map(e => [e[1], Math.round(e[2]), Math.round(e[3]), Math.round(e[4])]) };
        o.visible = document.visibilityState === 'visible';
        return o;
    };
    // The longest main-thread tasks that began in the window ([start, ms]), for matching with a CPU profile.
    P.tasks = (t0, t1, minMs, n) => longs.filter(l => l[0] >= t0 && l[0] <= t1 && l[1] >= (minMs || 100)).sort((a, b) => b[1] - a[1]).slice(0, n || 3).map(l => [l[0], l[1]]);
    P.now = now;
    P.mark = label => { P.marks.push([now(), label]); if (P.marks.length > 500) P.marks.splice(0, 100); };

    // ---- state ----
    const num = (f, d) => { try { const v = f(); return v === undefined ? d : v; } catch (e) { return d; } };
    P.state = () => {
        const s = {};
        s.t = now();
        s.started = num(() => !!gameStarted, false); s.over = num(() => !!gameOver, false); s.defeated = num(() => !!localDefeated, false);
        s.tick = num(() => simClientStats().appliedTick, -1);
        s.units = num(() => units.length, -1);
        s.sel = num(() => [selectedUnits.length, selectedEntities.length], [-1, -1]);
        s.view = num(() => renderDimensionMode + (renderTeamColorsOnly ? '.5' : ''), '?');
        s.zoom = num(() => Math.round(camera.zoom * 1000) / 1000, 0);
        s.zoomRel = num(() => Math.round(camera.zoom / getMinCameraZoom() * 100) / 100, 0);
        s.cam = num(() => [Math.round(camera.x), Math.round(camera.y)], null);
        s.build = num(() => !!selectedBuildItem, false);
        s.attackMove = num(() => !!attackMoveMode, false);
        s.popups = [...document.querySelectorAll('[id$="-popup"], dialog[open], #jukebox-panel[open]')].filter(e => e.offsetParent !== null || e.open).map(e => e.id).slice(0, 8);
        s.menu = !!document.querySelector('.bb-menu, [role="menu"]');
        s.nodes = document.getElementsByTagName('*').length;
        s.panelNodes = num(() => document.getElementById('info-panel').getElementsByTagName('*').length, -1);
        // The settings that change what a frame costs (graphics, rally lines, outlines, ranges...): the fuzzer's settings trials move them.
        s.settings = {};
        for (const el of document.querySelectorAll('[id^="setting-"], select#btn-level-visibility, select#btn-render-range')) { if (el.tagName === 'SELECT' || el.tagName === 'INPUT') s.settings[el.id.replace(/^setting-/, '')] = el.type === 'checkbox' ? (el.checked ? 1 : 0) : el.value; }
        s.vis = document.visibilityState;
        s.focus = document.hasFocus();
        s.mem = performance.memory ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize } : null;
        s.gl = window.__pfgl ? { ...window.__pfgl } : null;
        s.sim = num(() => { const c = simClientStats(); return { helpers: c.helpers, inFlight: c.inFlight, ahead: c.workerAhead, errors: c.errors && c.errors.length, auto: c.auto, applyMs: c.applyMs && c.applyMs.mean }; }, null);
        s.res = num(() => ({ energy: document.getElementById('hud-energy').textContent.trim().slice(0, 14), pop: document.getElementById('hud-pop').textContent.trim().slice(0, 30) }), null);
        // Lockstep health (multiplayer only).
        s.net = num(() => isMultiplayer ? { desyncs: netCounters.desyncsDetected, patches: netCounters.patches, full: netCounters.fullPatches, hard: netCounters.hardResyncs, stop: !!lockstepFatalStopActive, paused: !!lockstepResyncPauseActive } : null, null);
        s.hooks = P.hooks;
        return s;
    };

    // ---- geometry ----
    const areaRect = () => document.getElementById('game-area').getBoundingClientRect();
    const toScreen = (wx, wy, r) => {
        if (renderDimensionMode === '3d' && typeof renderer3dInstance !== 'undefined' && renderer3dInstance && renderer3dInstance.projectWorldToScreen) {
            const p = renderer3dInstance.projectWorldToScreen(wx / TILE, 0, wy / TILE);
            return p && Number.isFinite(p.x) ? [p.x + r.left, p.y + r.top] : null;
        }
        return [(wx - camera.x) * camera.zoom + r.left, (wy - camera.y) * camera.zoom + r.top];
    };
    P.toScreen = toScreen;
    const inRect = (p, r, m) => p && p[0] > r.left + m && p[0] < r.right - m && p[1] > r.top + m && p[1] < r.bottom - m;
    P.geom = (seed) => {
        let s = (seed >>> 0) || 1;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        const r = areaRect(), g = { rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } };
        const mm = document.getElementById('minimapCanvas'), mr = mm && mm.getBoundingClientRect();
        g.minimap = mr && mr.width ? { left: mr.left, top: mr.top, width: mr.width, height: mr.height } : null;
        g.world = { w: WORLD_W, h: WORLD_H, tile: TILE, gw: GRID_W, gh: GRID_H };
        g.local = localPlayerId;
        g.view = renderDimensionMode;
        // Units: the frame's columns, strided (a few thousand reads, not a pass over millions).
        const F = typeof simClientCurrentUnitVis === 'function' ? simClientCurrentUnitVis() : null;
        const own = { n: 0, total: 0, vis: 0, pts: [], bbox: null, wx: 0, wy: 0 }, foe = { n: 0, total: 0, vis: 0, pts: [], bbox: null, wx: 0, wy: 0 };
        const take = (grp, sx, sy, wx, wy, scale) => {
            grp.n++; grp.wx += wx; grp.wy += wy;
            if (inRect([sx, sy], r, 4)) {
                grp.vis += scale;
                const b = grp.bbox || (grp.bbox = [sx, sy, sx, sy]);
                if (sx < b[0]) b[0] = sx; if (sy < b[1]) b[1] = sy; if (sx > b[2]) b[2] = sx; if (sy > b[3]) b[3] = sy;
                if (grp.pts.length < 40) grp.pts.push([Math.round(sx), Math.round(sy)]);
                else if (rnd() < 0.05) grp.pts[Math.floor(rnd() * 40)] = [Math.round(sx), Math.round(sy)];
            }
        };
        if (F && F.count > 0) {
            const flat = renderDimensionMode !== '3d', budget = flat ? 8000 : 2500, stride = Math.max(1, Math.floor(F.count / budget)), off = Math.floor(rnd() * stride);
            const cx = camera.x, cy = camera.y, cz = camera.zoom, rl = r.left, rt = r.top;
            for (let k = off; k < F.count; k += stride) {
                const slot = F.order[k], ow = F.owner[slot], wx = F.x[slot], wy = F.y[slot];
                let sx, sy;
                if (flat) { sx = (wx - cx) * cz + rl; sy = (wy - cy) * cz + rt; } else { const p = toScreen(wx, wy, r); sx = p ? p[0] : -1e9; sy = p ? p[1] : -1e9; }
                if (ow === localPlayerId) { own.total += stride; take(own, sx, sy, wx, wy, stride); }
                else { foe.total += stride; take(foe, sx, sy, wx, wy, stride); }
            }
            g.frameUnits = F.count;
        }
        for (const grp of [own, foe]) { if (grp.n) { grp.wx = Math.round(grp.wx / grp.n); grp.wy = Math.round(grp.wy / grp.n); } if (grp.bbox) grp.bbox = grp.bbox.map(Math.round); delete grp.n; }
        g.own = own; g.foe = foe;
        // Structures: own and enemy samples (strided), on screen.
        const structs = { own: [], foe: [], ownTotal: 0, foeTotal: 0, bx: 0, by: 0, bn: 0, fx: 0, fy: 0, fn: 0 };
        const scan = (list, kind) => {
            if (!list || !list.length) return;
            const stride = Math.max(1, Math.floor(list.length / 3000)), off = Math.floor(rnd() * stride);
            for (let i = off; i < list.length; i += stride) {
                const b = list[i];
                if (!b || !(b.energy > 0) || b.underConstruction) continue;
                const mine = b.owner === localPlayerId;
                if (mine) { structs.ownTotal += stride; structs.bx += b.x; structs.by += b.y; structs.bn++; } else { structs.foeTotal += stride; structs.fx += b.x; structs.fy += b.y; structs.fn++; }
                const p = toScreen(b.x, b.y, r);
                if (!inRect(p, r, 6)) continue;
                const arr = mine ? structs.own : structs.foe;
                if (arr.length < 60) arr.push([Math.round(p[0]), Math.round(p[1]), kind]);
                else if (rnd() < 0.04) arr[Math.floor(rnd() * 60)] = [Math.round(p[0]), Math.round(p[1]), kind];
            }
        };
        try { scan(barracks, 'b'); scan(towers, 't'); scan(collectorSpawners, 's'); } catch (e) { note('geom structs', e); }
        structs.base = structs.bn ? [Math.round(structs.bx / structs.bn), Math.round(structs.by / structs.bn)] : null;
        structs.enemyBase = structs.fn ? [Math.round(structs.fx / structs.fn), Math.round(structs.fy / structs.fn)] : null;
        delete structs.bx; delete structs.by; delete structs.bn; delete structs.fx; delete structs.fy; delete structs.fn;
        g.structs = structs;
        // The world's positions a click may order units to: where the army and the enemy are.
        g.army = own.total ? [own.wx, own.wy] : null;
        g.enemy = foe.total ? [foe.wx, foe.wy] : null;
        return g;
    };
    // Where a world position is on the screen (null: off screen or not projectable).
    P.screenOf = (wx, wy) => { const r = areaRect(), p = toScreen(wx, wy, r); return inRect(p, r, 4) ? [Math.round(p[0]), Math.round(p[1])] : null; };

    // Camera: direct (a context change, not a player action). zoom: 'min' | 'mid' | 'close' | number (relative to the minimum); at: [wx, wy] | 'map'.
    P.cam = (zoom, at) => {
        const min = getMinCameraZoom();
        let z = typeof zoom === 'number' ? min * zoom : zoom === 'close' ? Math.min(MAX_CAMERA_ZOOM, min * 12) : zoom === 'mid' ? min * 4 : min;
        z = Math.max(min, Math.min(MAX_CAMERA_ZOOM, z));
        camera.zoom = z;
        const c = at === 'map' || !at ? [WORLD_W / 2, WORLD_H / 2] : at;
        camera.x = c[0] - viewW / z / 2; camera.y = c[1] - viewH / z / 2;
        if (typeof clampCamera === 'function') clampCamera();
        return { zoom: camera.zoom, rel: camera.zoom / min };
    };

    // ---- controls (generic DOM-driven clicking) ----
    const SKIP = /leave|resign|quit|exit|restart|new.?game|surrender|forfeit|disconnect|kick|download|export|import|upload|snapshot|fullscreen|jukebox-external|config-apply|config-reset|go-btn|rematch|play.?again|main.?menu|lobby|hostgame|spectat|☠|btn-fs\b|open-optimization|open-config|salvage/i;
    const SELECTOR = 'button, input, select, summary, [onclick], [role="button"], [role="tab"], [data-action], [data-bb-act], [data-bb-boost], [data-id], [data-tab], [data-mode], [data-key], [data-thing-id], .build-item, .build-tab, .bb-thing, .bb-task, .control-group-btn, .count-slider, .info-section-toggle, #minimapCanvas, [class*="toggle"], [class*="-btn"], [class*="option"]';
    const regionOf = el => {
        const pop = el.closest('[id$="-popup"], dialog, #jukebox-panel'); if (pop) return 'popup:' + (pop.id || 'dialog');
        if (el.closest('.bb-menu')) return 'bbmenu';
        for (const id of ['hud', 'build-bar', 'bottom-bar', 'right-panel', 'left-panel', 'minimap-wrap', 'control-group-bar', 'game-area']) if (el.closest('#' + id)) return id;
        return 'page';
    };
    // o: { max (60), region (regex on the region name), re (regex on the label), ids: [element ids] (fast path) }.
    // Label and region are cheap; the layout-forcing calls (rect, hit test) come last and only for what passed.
    P.controls = (seed, o) => {
        o = o || {};
        let s = (seed >>> 0) || 1;
        const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        const max = o.max || 60, reg = o.region ? new RegExp(o.region) : null, re = o.re ? new RegExp(o.re, 'i') : null;
        const all = o.ids ? o.ids.map(id => document.getElementById(id)).filter(Boolean) : [...document.querySelectorAll(SELECTOR)], out = [];
        for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = all[i]; all[i] = all[j]; all[j] = t; }
        for (const el of all) {
            if (out.length >= max) break;
            if (el.disabled) continue;
            const label = ((el.id || '') + ' ' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '') + ' ' + (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24) + ' ' + (el.getAttribute('title') || '').slice(0, 20)).trim();
            if ((!o.noSkip && SKIP.test(label)) || el.type === 'file' || (el.tagName === 'A' && el.href)) continue;
            const region = regionOf(el);
            if (reg && !reg.test(region)) continue;
            if (re && !re.test(label)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 3 || r.height < 3 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
            const cx = Math.min(innerWidth - 2, Math.max(2, r.left + r.width / 2)), cy = Math.min(innerHeight - 2, Math.max(2, r.top + r.height / 2));
            const hit = document.elementFromPoint(cx, cy);
            if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) continue;
            out.push({ x: Math.round(cx), y: Math.round(cy), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '', region, label: label.slice(0, 60),
                options: el.tagName === 'SELECT' ? [...el.options].map(op => op.value).slice(0, 24) : undefined, value: el.tagName === 'SELECT' || el.type === 'range' ? el.value : undefined,
                min: el.type === 'range' ? Number(el.min) : undefined, max: el.type === 'range' ? Number(el.max) : undefined });
        }
        return out;
    };
    // A select changed the way a player's pick does (the native popup is not drivable): value, input, change.
    P.setSelect = (x, y, value) => {
        const el = document.elementFromPoint(x, y); const sel = el && (el.tagName === 'SELECT' ? el : el.closest('select'));
        if (!sel) return false;
        sel.value = value; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value === value;
    };
    P.setRange = (x, y, frac) => {
        const el = document.elementFromPoint(x, y); const rg = el && (el.type === 'range' ? el : el.closest('input[type=range]'));
        if (!rg) return false;
        const lo = Number(rg.min) || 0, hi = Number(rg.max) || 100; rg.value = String(Math.round(lo + (hi - lo) * frac));
        rg.dispatchEvent(new Event('input', { bubbles: true })); rg.dispatchEvent(new Event('change', { bubbles: true })); return true;
    };

    // ---- planted slowdowns (the fuzzer's own self-test): "fnName:ms[:everyN]" busy-waits in the page function ----
    P.plant = spec => {
        const [name, ms, every] = String(spec).split(':'); const f = window[name];
        if (typeof f !== 'function') return false;
        let n = 0; const spin = Number(ms) || 50, each = Number(every) || 1;
        window[name] = function () { if (++n % each === 0) { const a = now(); while (now() - a < spin); } return f.apply(this, arguments); };
        P.planted[name] = spin; return true;
    };
    return 'installed';
})();
