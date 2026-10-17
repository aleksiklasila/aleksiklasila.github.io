'use strict';

// Opt-in diagnostics in the real game: ?loadmetrics=1&loadfixture=2m.
// Observe startup and gameplay; never pause, enforce memory limits, or launch
// another match. No entity scans, snapshots or WASM kernels are added.
(() => {
    if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) return;
    if (typeof window === 'undefined' || !new URLSearchParams(location.search).has('loadmetrics')) return;
    const KEY = 'defence3_load_metrics_v1', params = new URLSearchParams(location.search);
    let report, previous = null, frameCount = 0, frameAt = null, frameTimes = [], currentStage = 'Menu';
    let panel, output, status, worldBuilding = false, placed = 0, spawned = 0, fixture = null;
    let lastSaved = null;
    try { lastSaved = JSON.parse(localStorage.getItem(KEY)); } catch {}
    const now = () => performance.now();
    const ms = value => Number.isFinite(value) ? (value / 1000).toFixed(2) + ' s' : '—';
    function save() {
        if (!report) return;
        try { localStorage.setItem(KEY, JSON.stringify(report)); } catch {}
    }
    function mark(stage, detail = {}) {
        if (!report) return;
        currentStage = stage;
        const event = { stage, atMs: now() - report.startAt, ...detail };
        if (report.events.length < 512) report.events.push(event);
        console.info('[Load metrics]', event);
        save(); show();
    }
    function begin() {
        if (report) lastSaved = report;
        previous = null; frameCount = 0; frameAt = null; frameTimes = [];
        placed = spawned = 0;
        const perTeam = Object.entries(startingResourcesConfig.spawnCounts || {}).reduce((totals, [key, levels]) => {
            totals[key.startsWith('unit:') ? 'units' : 'statics'] += Object.values(levels).reduce((sum, n) => sum + Number(n), 0);
            return totals;
        }, { units: 0, statics: 0 });
        report = { version: 1, started: new Date().toISOString(), startAt: now(), fixture,
            requested: { perTeam, teams: activeTeamIds.length, map: Number(document.getElementById('cfg-mapsize').value) },
            environment: { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
                isolated: crossOriginIsolated, helpers: _simClient?.helpers ?? null },
            events: [], phases: {}, samples: [], errors: [], longestTaskMs: 0, stableNow: false,
            notes: 'FPS counts completed page render calls. TPS uses authoritative worker ticks when active. Stage timings overlap. Stability means three 2-second windows within 15%, after at least 10 seconds; it does not imply fast performance.' };
        mark('Preparing models');
    }
    function wrap(name, label) {
        const original = window[name];
        if (typeof original !== 'function') return;
        window[name] = function(...args) {
            if (!report || (gameStarted && report.firstTickMs != null && name !== 'simClientStartMatch')) return original.apply(this, args);
            const t = now(); mark(label);
            const end = () => {
                const row = report.phases[label] ||= { calls: 0, ms: 0 };
                row.calls++; row.ms += now() - t;
                mark(label + ' complete', { durationMs: now() - t });
            };
            try {
                const result = original.apply(this, args);
                if (result?.then) result.then(end, error => { end(); recordError(error); });
                else end();
                return result;
            } catch (error) { end(); recordError(error); throw error; }
        };
    }
    function recordError(error) {
        if (!report) return;
        if (report.errors.length < 32) report.errors.push(String(error?.stack || error));
        mark('Error', { message: String(error?.message || error).slice(0, 500) });
    }
    const solo = startSoloGame;
    startSoloGame = function(...args) {
        if (!_soloStartPreparation) begin();
        return solo.apply(this, args);
    };
    for (const [name, label] of Object.entries({ prepareRendererLodAssets: 'Model preparation', initGrid: 'Grid allocation',
        generateAreas: 'Terrain generation', pickPlayerSpawns: 'Spawn planning', generateResourceMinesMixed: 'Resource placement',
        settleSpawnsNearResources: 'Spawn adjustment', simUnitStateReserve: 'Unit storage reservation',
        recalculateAdjacency: 'Adjacency', buildHostAuthoritativeStateSnapshot: 'Snapshot encoding',
        snapDecodeState: 'Page snapshot restore', simClientStartMatch: 'Worker handoff' })) wrap(name, label);
    const start = startGame;
    startGame = function(...args) {
        if (!report) begin();
        const t = now(); worldBuilding = true; mark('World creation');
        try {
            const result = start.apply(this, args);
            report.worldCreationMs = now() - t;
            report.seed = gameSeed;
            report.created = { units: units.length, buildingsAndItems: placed,
                unitsByOwner: activeTeamIds.map(owner => ({ owner, count: players[owner].popCount })) };
            mark('World created', report.created);
            return result;
        } catch (error) { recordError(error); throw error; }
        finally { worldBuilding = false; }
    };
    const place = placeBuilding;
    placeBuilding = function() {
        const result = place.apply(this, arguments);
        if (worldBuilding && result && ++placed % 5000 === 0) mark('Placing buildings/items', { created: placed });
        return result;
    };
    const push = unitSlotMapPushed;
    unitSlotMapPushed = function(u) {
        const result = push(u);
        if (worldBuilding && ++spawned % 65536 === 0) mark('Creating units', { created: spawned });
        return result;
    };
    const message = _simClientOnMessage;
    _simClientOnMessage = function(msg) {
        const result = message.apply(this, arguments);
        if (report && msg.epoch === _simClient?.epoch && msg.type === 'started') {
            report.workerReadyMs = now() - report.startAt;
            report.workerStartup = msg.timings || null;
            mark('Worker ready', { timings: report.workerStartup });
        }
        if (report && msg.type === 'error') recordError(msg.where + ': ' + msg.message);
        return result;
    };
    const draw = processRenderFrame;
    processRenderFrame = function(...args) {
        const result = draw.apply(this, args);
        if (report && gameStarted && units.length && (!simClientActive() || simClientWorldReady())) {
            const t = now(); frameCount++;
            if (frameAt !== null && frameTimes.length < 4096) frameTimes.push(t - frameAt);
            frameAt = t;
            if (report.firstFrameMs == null) { report.firstFrameMs = t - report.startAt; mark('First world frame'); }
        }
        return result;
    };
    window.addEventListener('error', e => recordError(e.error || e.message));
    window.addEventListener('unhandledrejection', e => recordError(e.reason));
    try {
        new PerformanceObserver(list => {
            if (report) for (const task of list.getEntries()) if (task.startTime >= report.startAt) report.longestTaskMs = Math.max(report.longestTaskMs, task.duration);
        }).observe({ type: 'longtask' });
    } catch {}
    function sample() {
        if (!report || !gameStarted || document.hidden) { previous = null; frameAt = null; frameTimes = []; show(); return; }
        const t = now(), tick = simClientActive() ? simClientWorkerTick() + 1 : currentTick;
        if (tick > 0 && report.firstTickMs == null) { report.firstTickMs = t - report.startAt; mark('Gameplay running'); }
        const point = { at: t, tick, frames: frameCount, pageTick: currentTick };
        if (previous && t > previous.at && report.firstFrameMs != null && tick > 0) {
            const seconds = (t - previous.at) / 1000;
            frameTimes.sort((a, b) => a - b);
            const row = { atMs: t - report.startAt, windowMs: t - previous.at, tps: (tick - previous.tick) / seconds,
                pageTps: (currentTick - previous.pageTick) / seconds, fps: (frameCount - previous.frames) / seconds,
                frameP95Ms: frameTimes.length ? frameTimes[Math.floor((frameTimes.length - 1) * .95)] : null,
                units: units.length, mode: renderDimensionMode, gameOver };
            report.samples.push(row); if (report.samples.length > 300) report.samples.shift();
            const recent = report.samples.slice(-3);
            report.stableNow = !gameOver && t - report.startAt - report.firstFrameMs >= 10000 && recent.length === 3 &&
                ['fps', 'tps'].every(key => {
                    const values = recent.map(r => r[key]), mean = values.reduce((a, b) => a + b, 0) / 3;
                    return mean > 0 && (Math.max(...values) - Math.min(...values)) / mean <= .15;
                });
            if (report.stableNow && report.firstStableMs == null) { report.firstStableMs = t - report.startAt; mark('First stable performance'); }
            currentStage = gameOver ? 'Match ended' : report.stableNow ? 'Running · stable' : 'Running · settling';
            save();
        }
        previous = point; frameTimes = []; show();
    }
    function show() {
        if (!output) return;
        const r = report, latest = r?.samples.at(-1);
        status.textContent = 'Load metrics · ' + (latest ? `${latest.tps.toFixed(1)} TPS · ${latest.fps.toFixed(1)} FPS` : currentStage);
        if (!r) { output.textContent = 'Choose a preset, then press Play Solo.\n200k buildings/items · 1000×1000 · two teams\nNo memory cutoffs or automatic stopping.'; return; }
        output.textContent = `${currentStage}\nElapsed: ${ms(now() - r.startAt)}\nWorld creation: ${ms(r.worldCreationMs)}\nWorker ready: ${ms(r.workerReadyMs)}\nFirst frame: ${ms(r.firstFrameMs)}\nFirst stable: ${ms(r.firstStableMs)}\nCreated: ${r.created?.units?.toLocaleString() ?? spawned.toLocaleString()} units / ${(r.created?.buildingsAndItems ?? placed).toLocaleString()} items\n` +
            (latest ? `Live units: ${latest.units.toLocaleString()}\nTPS: ${latest.tps.toFixed(2)} · FPS: ${latest.fps.toFixed(2)}\nFrame p95: ${latest.frameP95Ms?.toFixed(1) ?? '—'} ms\n` : '') +
            `Longest page task: ${ms(r.longestTaskMs)}\n` + Object.entries(r.phases).map(([key, value]) => `${key}: ${ms(value.ms)}`).join('\n') +
            (r.errors.length ? '\nError: ' + r.errors.at(-1).split('\n')[0] : '');
    }
    function download(value) {
        if (!value) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = 'load-metrics-' + value.started.replace(/[:.]/g, '-') + '.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function loadPreset(size) {
        if (gameStarted) { currentStage = 'Return to the menu before importing'; show(); return; }
        const response = await fetch(`./tests/load-${size}-200k-1000.json`);
        if (!response.ok) throw Error('Preset HTTP ' + response.status);
        const data = await response.json(); applyMainMenuSettingsSnapshot(data);
        fixture = data.loadTest; currentStage = `${size.toUpperCase()} configured · press Play Solo`; show();
    }
    window.loadMetrics = { get report() { return report; }, loadPreset, download: () => download(report), previous: () => download(lastSaved) };
    window.addEventListener('load', () => {
        panel = document.createElement('details'); panel.id = 'load-metrics-panel'; panel.open = true;
        panel.style.cssText = 'position:fixed;left:12px;top:12px;z-index:99999;max-width:350px;max-height:70vh;overflow:auto;padding:10px;background:#101820ed;color:#d9f4ff;border:1px solid #568297;border-radius:6px;font:12px monospace';
        status = document.createElement('summary'); panel.appendChild(status);
        const controls = document.createElement('div'); controls.style.marginTop = '8px';
        for (const size of ['2m', '4m', '8m']) {
            const button = document.createElement('button'); button.textContent = 'Load ' + size.toUpperCase();
            button.onclick = () => loadPreset(size).catch(error => { currentStage = String(error); show(); }); controls.appendChild(button);
        }
        for (const [label, action] of [['Save metrics', () => download(report)], ['Previous run', () => download(lastSaved)]]) {
            const button = document.createElement('button'); button.textContent = label; button.onclick = action; controls.appendChild(button);
        }
        output = document.createElement('pre'); output.style.cssText = 'white-space:pre-wrap;margin-bottom:0';
        panel.append(controls, output); document.body.appendChild(panel); show();
        const preset = params.get('loadfixture');
        if (['2m', '4m', '8m'].includes(preset)) loadPreset(preset).catch(error => { currentStage = String(error); show(); });
        setInterval(sample, 2000);
    });
})();
