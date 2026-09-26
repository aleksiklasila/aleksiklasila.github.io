// Rally/selection lag benchmark. Load from the console (or the preview):
//   await (0,eval)(await (await fetch('/rng/defence3/.claude/rallybench.js')).text());
//   await RALLY.setup({ copies: 1 })   // new game: `copies` of every unit and building
//   RALLY.selectAll()
//   RALLY.run({ clicks: 12, framesPerClick: 60, fps: 120 })
// Frames are driven synchronously (the real loop's order: due ticks, then
// processRenderFrame) so a hidden tab can be measured. Each frame's time is
// split by function; `spikes` lists the slowest frames with their breakdown.
(() => {
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WRAP = ['gameTick', 'build3DFrameData', 'drawMinimap', 'drawInteractionOverlay', 'flushTickUiRequests', 'updateHUD',
    'updateControlGroupBar', 'updateBuildMenu', 'updateInfoPanel', 'commitStaticCaches', 'updateCamera'];
let current = null;
const originals = {};
function wrapAll() {
    for (const name of WRAP) {
        if (originals[name] || typeof window[name] !== 'function') continue;
        const fn = originals[name] = window[name];
        window[name] = function (...args) {
            if (!current) return fn.apply(this, args);
            const t = performance.now();
            try { return fn.apply(this, args); } finally { current[name] = (current[name] || 0) + performance.now() - t; }
        };
    }
    const r = typeof renderer3dInstance !== 'undefined' && renderer3dInstance;
    if (r && !r._rallyWrapped) {
        const render = r.render;
        r.render = function (...args) {
            const t = performance.now();
            try { return render.apply(this, args); } finally { if (current) current.gl = (current.gl || 0) + performance.now() - t; }
        };
        r._rallyWrapped = true;
    }
}

const RALLY = {
    async setup({ copies = 1, size = 60 } = {}) {
        const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = String(v); e.dispatchEvent(new Event('change')); } };
        set('cfg-mapsize', size); set('cfg-starting-energy', 5e9); set('cfg-starting-astar', 5e9);
        const keys = Object.keys(BASE_CARD_TYPES).filter(k => !['area_upgrader', 'sand', 'lava', 'poison_puddle', 'ice_patch',
            'water_puddle', 'mine'].includes(k) && !k.startsWith('cloud'));
        const unitTypes = Object.keys(BASE_UNIT_STATS).filter(k => k !== 'king' && !k.startsWith('_'));
        startingResourcesConfig = { researchLevels: {}, spawnCounts: Object.fromEntries([
            ...keys.map(k => ['building:' + k, { 1: copies }]), ...unitTypes.map(u => ['unit:' + u, { 1: copies }])]) };
        [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play Solo').click();
        await sleep(1200);
        if (typeof netStopBackgroundTicker === 'function') netStopBackgroundTicker();
        _backgroundTickInterval = null;
        refreshBackgroundTickMode = () => {};
        const h = getCellItemsRowMajor().find(i => i.type === 'house' && grid[i.gy][i.gx].owner === localPlayerId);
        camera.zoom = 1; if (camera.targetZoom !== undefined) camera.targetZoom = 1;
        camera.x = (h.gx + .5) * TILE - viewW / 2; camera.y = (h.gy + .5) * TILE - viewH / 2;
        wrapAll();
        return { units: units.filter(u => u.owner === localPlayerId).length, buildings: _getOwnedInfoPanelBuildings(localPlayerId).length };
    },
    // Every variant from one page: warm-up, then each case in turn.
    matrix({ clicks = 16, framesPerClick = 60 } = {}) {
        const out = {};
        const pick = r => ({ mean: r.mean, p95: r.p95, p99: r.p99, max: r.max, over8ms: r.over8ms,
            clickMean: r.clickMs.length ? Math.round(r.clickMs.reduce((a, b) => a + b, 0) / r.clickMs.length * 100) / 100 : 0 });
        RALLY.clear(); RALLY.run({ clicks: 4, framesPerClick, noClick: true });
        RALLY.clear(); out.noneSelectedIdle = pick(RALLY.run({ clicks, framesPerClick, noClick: true }));
        RALLY.selectAll(); out.allSelectedIdle = pick(RALLY.run({ clicks, framesPerClick, noClick: true }));
        out.allSelectedRally = pick(RALLY.run({ clicks, framesPerClick }));
        out.reselectRally = pick(RALLY.run({ clicks, framesPerClick, reselect: true }));
        return out;
    },

    // Info panel stability: park the mouse on a panel control (scrolled to
    // the middle), then change levels, queues, deaths and worker states while
    // refreshing. Counts refreshes where the control under the mouse moved
    // or changed. Deaths of the hovered thing itself are excluded.
    stability({ rounds = 240, seed = 11, textChaos = true } = {}) {
        let s = seed >>> 0 || 1;
        const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
        const panel = document.getElementById('info-panel');
        RALLY.selectAll();
        updateInfoPanel();
        panel.scrollTop = Math.max(0, (panel.scrollHeight - panel.clientHeight) / 2);
        const pr = panel.getBoundingClientRect();
        const pickTarget = () => {
            let best = null, bestD = Infinity;
            for (const el of panel.querySelectorAll('button')) {
                const r = el.getBoundingClientRect();
                if (r.height <= 0 || r.top < pr.top + 20 || r.bottom > pr.bottom - 20) continue;
                const d = Math.abs((r.top + r.bottom) / 2 - (pr.top + pr.bottom) / 2);
                if (d < bestD) { bestD = d; best = el; }
            }
            return best;
        };
        let target = pickTarget();
        if (!target) return { error: 'no target' };
        let tr = target.getBoundingClientRect();
        uiMouseClientX = tr.left + tr.width / 2; uiMouseClientY = tr.top + tr.height / 2;
        const keyAt = () => {
            const el = document.elementFromPoint(uiMouseClientX, uiMouseClientY);
            const a = el && (el.closest('button') || el);
            return a ? { el: a, key: getInfoPanelAnchorAttributeKey(a), top: a.getBoundingClientRect().top } : null;
        };
        let before = keyAt();
        const log = [];
        let moved = 0, changed = 0, rebuilt = 0, hoveredGone = 0, sectionRebuilds = 0;
        const own = () => units.filter(u => u.owner === localPlayerId && !u.dead);
        const ownBuildings = () => _getOwnedInfoPanelBuildings(localPlayerId);
        for (let round = 0; round < rounds; round++) {
            const k = rand();
            if (k < .35) { const us = own(); const u = us[Math.floor(rand() * us.length)]; if (u) applyUnitLevelScaling(u, 1 + Math.floor(rand() * 40)); }
            else if (k < .55) { const bs = ownBuildings(); const b = bs[Math.floor(rand() * bs.length)]; if (b) { addManualStackToThing(b, 1 + Math.floor(rand() * 40)); updateItemTextCache(b); } }
            else if (k < .7) { const bs = barracks.filter(b => b.owner === localPlayerId); const b = bs[Math.floor(rand() * bs.length)]; if (b) queueAction({ action: 'queueUnit', gx: b.gx, gy: b.gy, count: 1 + Math.floor(rand() * 5) }); }
            else if (k < .75) { const us = own().filter(u => selectedUnits.includes(u)); const u = us[Math.floor(rand() * us.length)]; if (u && us.length > 5) queueAction({ action: 'killUnit', unitId: u.id }); }
            // Numbers gaining or losing digits (wrapping lines above the mouse).
            if (textChaos) for (let n = 0; n < 6; n++) {
                const pool = rand() < .5 ? selectedEntities : selectedUnits;
                const e = pool[Math.floor(rand() * pool.length)];
                if (!e || !(e.maxEnergy > 0)) continue;
                const scale = 10 ** (1 + Math.floor(rand() * 9));
                e.maxEnergy = scale; e.energy = Math.max(1, Math.floor(scale * (.2 + rand() * .8)));
            }
            for (let t = 0; t < 3; t++) gameTick();
            const renderBefore = panel._selectionRenderCache, sectionsBefore = renderBefore && renderBefore.sections ? renderBefore.sections.slice() : null;
            updateInfoPanel();
            const renderAfter = panel._selectionRenderCache;
            if (renderAfter !== renderBefore) rebuilt++;
            else if (sectionsBefore && renderAfter.sections) sectionRebuilds += renderAfter.sections.filter((x, i) => x !== sectionsBefore[i]).length;
            const after = keyAt();
            if (!before || !after) continue;
            if (!before.el.isConnected && !panel.contains(after.el)) { hoveredGone++; before = after; continue; }
            if (after.key !== before.key) { changed++; if (log.length < 6) log.push({ round, before: before.key.slice(0, 120), after: after.key.slice(0, 120) }); }
            else if (Math.abs(after.top - before.top) > 1) { moved++; if (log.length < 6) log.push({ round, dy: after.top - before.top }); }
            before = after;
        }
        return { rounds, rebuilt, sectionRebuilds, changed, moved, hoveredGone, log, target: before && before.key.slice(0, 100) };
    },
    clear() { selectedUnits = []; selectedEntities = []; updateInfoPanel(); },
    selectAll() {
        selectInfoPanelPlayerRoster('all-owned', 'total', 'all');
        return { units: selectedUnits.length, entities: selectedEntities.length };
    },
    // Right click at a world position through the real input handler.
    click(wx, wy) {
        const area = document.getElementById('game-area'), rect = area.getBoundingClientRect();
        const sx = (wx - camera.x) * camera.zoom + rect.left, sy = (wy - camera.y) * camera.zoom + rect.top;
        const opts = { clientX: sx, clientY: sy, button: 2, buttons: 2, bubbles: true };
        const t = performance.now();
        area.dispatchEvent(new MouseEvent('mousedown', opts));
        area.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        return performance.now() - t;
    },
    frame(now, stats) {
        wrapAll();
        current = stats;
        const t = performance.now();
        _tickAccumulator += 1000 / RALLY.fps;
        _tickAccumulator = pumpSimulationTicks(now, _tickAccumulator, 5);
        processRenderFrame(now);
        stats.total = performance.now() - t;
        current = null;
        return stats;
    },
    fps: 120,
    run({ clicks = 12, framesPerClick = 60, fps = 120, reselect = false, seed = 7, noClick = false } = {}) {
        RALLY.fps = fps;
        let s = seed >>> 0 || 1;
        const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
        const frames = [], clickTimes = [];
        let now = performance.now();
        for (let c = 0; c < clicks; c++) {
            if (reselect) { selectedUnits = []; selectedEntities = []; updateInfoPanel(); RALLY.selectAll(); }
            // A random floor tile near the camera.
            let wx = 0, wy = 0;
            for (let k = 0; k < 50; k++) {
                const gx = Math.floor((camera.x + rand() * viewW / camera.zoom) / TILE), gy = Math.floor((camera.y + rand() * viewH / camera.zoom) / TILE);
                if (grid[gy] && grid[gy][gx] && grid[gy][gx].type !== TYPE_WALL) { wx = gx * TILE + 16; wy = gy * TILE + 16; break; }
            }
            if (!noClick) clickTimes.push(RALLY.click(wx, wy));
            for (let f = 0; f < framesPerClick; f++) {
                now += 1000 / fps;
                frames.push(RALLY.frame(now, { click: c, f }));
            }
        }
        RALLY.lastFrames = frames;
        const totals = frames.map(f => f.total).sort((a, b) => a - b);
        const pct = p => totals[Math.min(totals.length - 1, Math.floor(totals.length * p))];
        const keys = [...new Set(frames.flatMap(f => Object.keys(f)))].filter(k => !['click', 'f', 'total'].includes(k));
        const sums = {};
        for (const k of keys) sums[k] = +(frames.reduce((a, f) => a + (f[k] || 0), 0) / frames.length).toFixed(3);
        const r2 = v => Math.round(v * 100) / 100;
        const spikes = [...frames].sort((a, b) => b.total - a.total).slice(0, 8)
            .map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'number' && !['click', 'f'].includes(k) ? r2(v) : v])));
        // Where the time of slow frames goes, summed by part.
        const slow = {};
        for (const f of frames) if (f.total > 8.3) for (const [k, v] of Object.entries(f)) if (!['click', 'f', 'total'].includes(k)) slow[k] = r2((slow[k] || 0) + v);
        return { slowFrameParts: slow, frames: frames.length, mean: r2(totals.reduce((a, b) => a + b, 0) / totals.length), p50: r2(pct(.5)), p95: r2(pct(.95)),
            p99: r2(pct(.99)), max: r2(totals[totals.length - 1]), over8ms: totals.filter(t => t > 8.3).length,
            clickMs: clickTimes.map(r2), meanByPart: sums, spikes };
    }
};
window.RALLY = RALLY;
return 'RALLY ready';
})();
