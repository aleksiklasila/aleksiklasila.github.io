"use strict";

// Portable solo saves use the same gameplay codec as joins and recovery.
// Render caches, particles and audio are rebuilt locally; they are not simulation state.
const SOLO_SNAPSHOT_KIND = 'defence3-solo-snapshot';
const SOLO_SNAPSHOT_VERSION = 1;
let _soloSnapshotExporting = false;
let _soloSnapshotImporting = false;

function buildSoloGameSnapshot(context) {
    if (!gameStarted || isMultiplayer) throw new Error('Snapshots are available in solo games only.');
    const match = buildHostAuthoritativeStateSnapshot();
    // Already-dispatched commands ran before this request in the worker's
    // stream. Only the page's still-pending input belongs after the snapshot.
    const pendingInput = {};
    for (const [tick, actions] of Object.entries(context.pendingInput || {})) {
        if (Number(tick) >= currentTick) pendingInput[tick] = actions;
    }
    return {
        kind: SOLO_SNAPSHOT_KIND, version: SOLO_SNAPSHOT_VERSION,
        createdAt: context.createdAt, gameSeed, match, pendingInput,
        localPlayerId: context.localPlayerId, camera: context.camera,
        tickIntervalMs: context.tickIntervalMs,
        teamColors: context.teamColors, startingResources: context.startingResources,
        localDefeated: context.localDefeated, localDefeatAuto: context.localDefeatAuto,
        spectateMode: context.spectateMode
    };
}

async function captureSoloGameSnapshotText() {
    if (!gameStarted || isMultiplayer) throw new Error('Snapshots are available in solo games only.');
    if (simClientActive() && !simClientWorldReady()) throw new Error('The match is still loading. Try again when it is ready.');
    const context = {
        createdAt: new Date().toISOString(), localPlayerId,
        tickIntervalMs: netSimulationTickMs(),
        camera: { x: camera.x, y: camera.y, zoom: camera.zoom },
        teamColors: { ...teamColorById }, startingResources: cloneStartingResourcesConfig(),
        localDefeated, localDefeatAuto, spectateMode,
        pendingInput: cloneSnapshotValue(localInputBuffer)
    };
    return simClientActive()
        ? simClientRequest('soloSnapshot', context)
        : JSON.stringify(buildSoloGameSnapshot(context));
}

// Check the envelope and codec structure before changing menu settings or
// starting a world. A settings export is deliberately a different file type.
function parseSoloGameSnapshot(text) {
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('The snapshot file is not valid JSON.'); }
    if (!data || data.kind !== SOLO_SNAPSHOT_KIND) throw new Error('Choose a game snapshot, not a settings export.');
    if (data.version !== SOLO_SNAPSHOT_VERSION) throw new Error('This snapshot file version is not supported.');
    const m = data.match, s = m && m.state, cfg = m && m.editableConfig && m.editableConfig.config;
    if (!s || s.v !== SNAP_FORMAT || s.rules !== SIM_RULES_REVISION) {
        throw new Error('This snapshot uses a different simulation version. Open it with the game version that exported it.');
    }
    const fail = () => { throw new Error('The snapshot is incomplete or damaged.'); };
    if (s.partial || !cfg || !Number.isSafeInteger(cfg.GRID_W) || !Number.isSafeInteger(cfg.GRID_H)
        || cfg.GRID_W < 8 || cfg.GRID_H < 8 || !Number.isFinite(cfg.TILE) || cfg.TILE < 8
        || !Number.isSafeInteger(m.currentTick) || m.currentTick < 0 || !s.g || s.g.tick !== m.currentTick
        || !Number.isFinite(m.gameTime) || m.gameTime !== s.g.gameTime || !Number.isFinite(data.gameSeed)
        || !Array.isArray(m.areas) || !s.lists || !Array.isArray(s.grid) || s.grid.length % 2
        || !Array.isArray(s.owners) || !Array.isArray(s.pool) || !Array.isArray(s.shapes) || !Array.isArray(s.tpls)) fail();
    for (const key of SNAP_LISTS) if (!Array.isArray(s.lists[key])) fail();
    if (!Number.isInteger(data.localPlayerId) || data.localPlayerId < 0 || data.localPlayerId >= s.lists.P.length
        || !Array.isArray(s.g.teams) || !s.g.teams.every(id => Number.isInteger(id) && id >= 0 && id < s.lists.P.length)) fail();
    let cells = 0;
    for (let i = 1; i < s.grid.length; i += 2) {
        if (!Number.isSafeInteger(s.grid[i]) || s.grid[i] <= 0) fail();
        cells += s.grid[i];
    }
    if (cells !== cfg.GRID_W * cfg.GRID_H) fail();
    for (const shape of s.shapes) if (!Array.isArray(shape) || !shape.every(k => typeof k === 'string')) fail();
    const columns = s.shapes.map(shape => shape.filter(k => !SNAP_SKIP_KEYS.has(k)).length);
    for (const tpl of s.tpls) {
        if (!Array.isArray(tpl) || !Number.isInteger(tpl[0]) || !s.shapes[tpl[0]] || !Array.isArray(tpl[1])
            || tpl[1].length !== columns[tpl[0]]) fail();
    }
    for (const rows of Object.values(s.lists)) for (const row of rows) {
        if (!Array.isArray(row) || row.length < 2 || row.length % 2 || !Number.isInteger(row[1]) || !s.tpls[row[1]]) fail();
        for (let i = 2; i < row.length; i += 2) {
            if (!Number.isInteger(row[i]) || row[i] < 0 || row[i] >= columns[s.tpls[row[1]][0]]) fail();
        }
    }
    if (!data.camera || !['x', 'y', 'zoom'].every(k => Number.isFinite(data.camera[k])) || data.camera.zoom <= 0) fail();
    if (!Number.isFinite(data.tickIntervalMs) || data.tickIntervalMs <= 0) fail();
    if (!data.pendingInput || typeof data.pendingInput !== 'object' || Array.isArray(data.pendingInput)) fail();
    for (const [tick, actions] of Object.entries(data.pendingInput)) {
        if (!Number.isSafeInteger(Number(tick)) || Number(tick) < m.currentTick || !Array.isArray(actions)
            || !actions.every(a => a && typeof a === 'object' && typeof a.action === 'string')) fail();
    }
    return data;
}

async function restoreSoloGameSnapshotText(text) {
    if (gameStarted || isMultiplayer || _soloStartPreparation) throw new Error('Return to the main menu before importing a snapshot.');
    const data = parseSoloGameSnapshot(text);
    await prepareRendererLodAssets(true);
    if (gameStarted || isMultiplayer || _soloStartPreparation) throw new Error('Return to the main menu before importing a snapshot.');
    try {
        isHost = false;
        gameSeed = data.gameSeed;
        localPlayerId = data.localPlayerId;
        activeTeamIds = data.match.state.g.teams.slice();
        teamColorById = { ...data.teamColors };
        applyEditableRuntimeConfigObject(data.match.editableConfig, { fromTransport: true });
        startingResourcesConfig = normalizeStartingResourcesConfig(data.startingResources);
        initAudio();
        startGameSkipStarters = true;
        try { startGame(); } finally { startGameSkipStarters = false; }
        localDefeated = !!data.localDefeated;
        localDefeatAuto = !!data.localDefeatAuto;
        spectateMode = ['none', 'defeated', 'postgame'].includes(data.spectateMode) ? data.spectateMode : 'none';
        // The worker gets the full text; the page restores only its display
        // replica, just as it does when joining a match from a snapshot.
        const matchText = JSON.stringify(data.match);
        const decode = () => {
            if (!applyAuthoritativeStateSnapshot(data.match)) throw new Error('The simulation refused this snapshot.');
        };
        const inWorker = simClientStartMatch(matchText, () => {
            simClientStripUnits(data.match.state);
            decode();
        });
        if (!inWorker) decode();
        localInputBuffer = cloneSnapshotValue(data.pendingInput);
        // Preserve the initial adaptive step size; subsequent timing adapts
        // to this machine just as it does in an ordinary solo match.
        netMatchTickMs = data.tickIntervalMs;
        netMatchPaceChangedAt = performance.now();
        Object.assign(camera, data.camera);
        clampCamera();
        _tickAccumulator = 0;
        _lastTickTime = performance.now();
        if (inWorker && !gameOver) _matchLoadOverlayUntilRunning();
        else setMatchLoadOverlay(false);
        if (gameOver) showGameOver();
        requestBuildMenuRefresh();
        updateInfoPanel();
        showUiBanner('Snapshot imported at tick ' + data.match.currentTick + '.', 'success');
        return data.match.currentTick;
    } catch (error) {
        simClientStop();
        _returnToMainMenuWithStatus('Snapshot import failed: ' + error.message, '#f66');
        throw error;
    }
}

async function downloadSoloGameSnapshot() {
    if (_soloSnapshotExporting) return;
    _soloSnapshotExporting = true;
    const button = document.getElementById('btn-export-snapshot');
    if (button) { button.disabled = true; button.textContent = 'Exporting…'; }
    try {
        const text = await captureSoloGameSnapshotText();
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'defence3-snapshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        document.body.appendChild(a);
        try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
        showUiBanner('Snapshot exported.', 'success');
    } catch (error) { showUiBanner('Snapshot export failed: ' + error.message, 'error', 6000); }
    finally {
        _soloSnapshotExporting = false;
        if (button) { button.disabled = false; button.textContent = 'Export Snapshot'; }
    }
}

function initSoloSnapshotControls() {
    const save = document.getElementById('btn-export-snapshot');
    const open = document.getElementById('btn-import-snapshot');
    const input = document.getElementById('input-import-snapshot');
    if (save) save.addEventListener('click', downloadSoloGameSnapshot);
    if (!open || !input) return;
    open.addEventListener('click', () => { input.value = ''; input.click(); });
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file || _soloSnapshotImporting) return;
        _soloSnapshotImporting = true;
        open.disabled = true;
        open.textContent = 'Importing…';
        try { await restoreSoloGameSnapshotText(await file.text()); }
        catch (error) { showUiBanner('Snapshot import failed: ' + error.message, 'error', 6000); }
        finally { _soloSnapshotImporting = false; open.disabled = false; open.textContent = 'Import Snapshot'; input.value = ''; }
    });
}
