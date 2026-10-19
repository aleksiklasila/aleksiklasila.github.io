"use strict";

// Portable scene format: public setup data, never the simulation's recovery
// codec or cached paths. Bounded JSON records avoid giant string allocations
// at millions of units. The first record is the header; the last checks counts.
const SOLO_SNAPSHOT_KIND = 'defence3-scene';
const SOLO_SNAPSHOT_VERSION = 1;
let _soloSnapshotExporting = false, _soloSnapshotImporting = false;

function buildSoloGameSnapshotParts(context) {
    if (!gameStarted || isMultiplayer) throw new Error('Snapshots are available in solo games only.');
    const parts = [], counts = { terrain: 0, areas: 0, mines: 0, buildings: 0, units: 0 };
    const emit = record => parts.push(JSON.stringify(record) + '\n');
    emit({ kind: SOLO_SNAPSHOT_KIND, version: SOLO_SNAPSHOT_VERSION, createdAt: context.createdAt,
        settings: context.settings, seed: gameSeed, width: GRID_W, height: GRID_H,
        teams: activeTeamIds, teamColors: context.teamColors, player: context.player, camera: context.camera,
        sourceTick: currentTick, players: players.map(p => ({ energy: p.energy, astar: p.astar,
            researchLevels: p.researchLevels })) });
    const batch = (key, iterable) => {
        let rows = [];
        for (const row of iterable) {
            rows.push(row); counts[key]++;
            if (rows.length === 1024) { emit({ [key]: rows }); rows = []; }
        }
        if (rows.length) emit({ [key]: rows });
    };
    batch('terrain', (function* () {
        for (let y = 0; y < GRID_H; y++) {
            const runs = [];
            for (const c of grid[y]) {
                const n = runs.length;
                if (n && runs[n-4] === c.type && runs[n-3] === c.owner && runs[n-2] === c.areaId) runs[n-1]++;
                else runs.push(c.type, c.owner, c.areaId, 1);
            }
            yield runs;
        }
    })());
    batch('areas', areas.map(a => ({ id: a.id, type: a.type, cells: a.cells,
        multiplierLevel: a.multiplierLevel || 0, minGx: a.minGx, minGy: a.minGy, maxGx: a.maxGx, maxGy: a.maxGy })));
    batch('mines', (function* () {
        for (const m of goldMines) yield ['energy', m.gx, m.gy, m.gold, m.maxGold];
        for (const m of astarMines) yield ['astar', m.gx, m.gy, m.astar, m.maxAstar];
    })());
    batch('buildings', (function* () {
        const seen = new Set();
        for (const list of [towers, barracks, collectorSpawners, getCellItemsRowMajor()]) for (const e of list) {
            if (!e || e instanceof GoldMine || e instanceof AstarMine || e.dead || !(e.energy > 0)) continue;
            if (seen.has(e)) continue;
            seen.add(e);
            const x = e.gx, y = e.gy;
            const target = e.rallyTargetUnitId != null ? _unitByIdMap().get(e.rallyTargetUnitId) : null;
            yield [e.type === 'barrack' ? 'barrack_' + e.unitType : e.type, e.owner, x, y,
                e.manualStacks || e.stacks || 1, e.energy, !!e.underConstruction,
                target ? target.x / TILE : Number.isFinite(e.rallyX) ? e.rallyX / TILE : null,
                target ? target.y / TILE : Number.isFinite(e.rallyY) ? e.rallyY / TILE : null,
                e.autoUpgradeEnabled !== false, e.buildEnabled !== false];
        }
    })());
    batch('units', (function* () {
        for (const u of units) {
            if (u.dead || !(u.energy > 0)) continue;
            let code = getUnitOrderDestinationCode(u);
            // Attack-move keeps its destination even while engaging a target.
            if (u._attackMoveGx != null) code = -(u._attackMoveGy * GRID_W + u._attackMoveGx + 1);
            const dest = Math.abs(code) - 1;
            yield [u.unitType, u.owner, u.x / TILE, u.y / TILE, u.energy,
                u.baseLevel || u.unitLevel || 1, u.stackCount || 1,
                code ? [code < 0 ? 'attackMove' : 'move', dest % GRID_W, Math.floor(dest / GRID_W)] : null,
                !!u.holdPosition];
        }
    })());
    emit({ end: counts });
    return parts;
}

async function captureSoloGameSnapshotParts() {
    if (!gameStarted || isMultiplayer) throw new Error('Snapshots are available in solo games only.');
    if (simClientActive() && !simClientWorldReady()) throw new Error('The match is still loading.');
    const settings = createMainMenuSettingsSnapshot();
    settings.editableConfig = serializeEditableRuntimeConfigForTransport();
    const context = { createdAt: new Date().toISOString(), settings, player: localPlayerId,
        teamColors: { ...teamColorById }, camera: { x: camera.x / TILE, y: camera.y / TILE, zoom: camera.zoom } };
    return simClientActive() ? simClientRequest('soloSnapshot', context) : buildSoloGameSnapshotParts(context);
}

// Parse a line at a time both from files and worker transport. No file.text(),
// giant JSON.parse or recovery-format / simulation-version dependency.
function soloSceneReader() {
    const scene = { header: null, records: [] }, counts = { terrain: 0, areas: 0, mines: 0, buildings: 0, units: 0 };
    let ended = false;
    const fail = () => { throw new Error('The scene snapshot is incomplete or damaged.'); };
    return {
        line(line) {
            if (!line.trim()) return;
            let r;
            try { r = JSON.parse(line); } catch { throw new Error('The scene snapshot contains invalid JSON.'); }
            if (ended || !r || typeof r !== 'object' || Array.isArray(r)) fail();
            if (!scene.header) {
                if (r.kind !== SOLO_SNAPSHOT_KIND) throw new Error('Choose a portable scene snapshot, not a settings export or an old exact save.');
                if (r.version !== SOLO_SNAPSHOT_VERSION) throw new Error('This scene file version is not supported.');
                if (!Number.isSafeInteger(r.width) || !Number.isSafeInteger(r.height) || r.width < 8 || r.height < 8
                    || r.width > 4096 || r.height > 4096 || !Number.isFinite(r.seed) || !r.settings
                    || !Array.isArray(r.players) || !r.players.length || r.players.length > 8
                    || !Array.isArray(r.teams) || !r.teams.length || !r.teams.every(p => Number.isInteger(p) && p >= 0 && p < r.players.length)
                    || !r.teams.includes(r.player) || !r.camera || !['x','y','zoom'].every(k => Number.isFinite(r.camera[k])) || r.camera.zoom <= 0) fail();
                for (const p of r.players) if (!p || !Number.isFinite(p.energy) || !Number.isFinite(p.astar)) fail();
                scene.header = r; return;
            }
            const keys = Object.keys(r), key = keys[0], h = scene.header;
            if (keys.length !== 1) fail();
            if (key === 'end') {
                if (!r.end || Object.keys(counts).some(k => counts[k] !== r.end[k]) || counts.terrain !== h.height) fail();
                ended = true; return;
            }
            if (!Object.hasOwn(counts, key) || !Array.isArray(r[key])) fail();
            const tile = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < h.width && y < h.height;
            for (const row of r[key]) {
                if (key === 'areas') {
                    if (!row || !Number.isInteger(row.id) || row.id < 0 || !Array.isArray(row.cells)
                        || !row.cells.every(c => c && tile(c.x, c.y))) fail();
                } else {
                    if (!Array.isArray(row)) fail();
                    if (key === 'terrain') {
                        if (row.length % 4) fail();
                        let n = 0;
                        for (let i = 0; i < row.length; i += 4) {
                            if (![row[i],row[i+1],row[i+2],row[i+3]].every(Number.isSafeInteger) || row[i+3] <= 0) fail();
                            n += row[i+3];
                        }
                        if (n !== h.width) fail();
                    } else if (key === 'mines') {
                        if (!['energy','astar'].includes(row[0]) || !tile(row[1],row[2]) || !Number.isFinite(row[3]) || !Number.isFinite(row[4])) fail();
                    } else {
                        if (typeof row[0] !== 'string' || !h.teams.includes(row[1])) fail();
                        if (key === 'buildings') {
                            if (!tile(row[2],row[3]) || !Number.isFinite(row[4]) || row[4] < 1 || !Number.isFinite(row[5])) fail();
                            if (row[7] != null && (!Number.isFinite(row[7]) || !Number.isFinite(row[8]))) fail();
                        } else {
                            // Continuous positions can lie just beyond an edge during
                            // crowd movement. Preserve them; spatial indexing clamps
                            // its tile lookup separately, as it does in a live game.
                            if (!Number.isFinite(row[2]) || !Number.isFinite(row[3])
                                || !Number.isFinite(row[4]) || !Number.isFinite(row[5]) || row[5] < 1 || !Number.isFinite(row[6]) || row[6] < 1) fail();
                            if (row[7] && (!Array.isArray(row[7]) || !['move','attackMove'].includes(row[7][0]) || !tile(row[7][1],row[7][2]))) fail();
                        }
                    }
                }
                counts[key]++;
            }
            scene.records.push(r);
        },
        finish() { if (!ended) fail(); return scene; }
    };
}
function parseSoloGameSnapshotParts(parts) {
    const reader = soloSceneReader();
    for (const part of parts) for (const line of part.split('\n')) reader.line(line);
    return reader.finish();
}
async function readSoloGameSnapshotFile(file) {
    const input = await openJsonFileStream(file);
    const reader = soloSceneFileReader(), decoder = new TextDecoder(), stream = input.getReader();
    try {
        for (;;) {
            const { done, value } = await stream.read();
            reader.push(decoder.decode(value, { stream: !done }));
            if (done) break;
        }
        return reader.finish();
    } catch (error) {
        await stream.cancel(error).catch(() => {});
        throw error;
    } finally { stream.releaseLock(); }
}

// Standard JSON array of records. Parse one record at a time, independent of
// whitespace/pretty-printing, retaining support for the earlier JSON Lines files.
function soloSceneFileReader() {
    const reader = soloSceneReader();
    let format = null, state = 'value', depth = 0, quoted = false, escaped = false, parts = [];
    const fail = () => { throw new Error('The scene snapshot contains invalid or incomplete JSON.'); };
    return {
        push(text) {
            let start = depth ? 0 : -1;
            for (let i = 0; i < text.length; i++) {
                const c = text[i];
                if (depth) {
                    if (quoted) {
                        if (escaped) escaped = false;
                        else if (c === '\\') escaped = true;
                        else if (c === '"') quoted = false;
                    } else if (c === '"') quoted = true;
                    else if (c === '{' || c === '[') depth++;
                    else if (c === '}' || c === ']') {
                        depth--;
                        if (!depth) {
                            parts.push(text.slice(start, i + 1)); reader.line(parts.join('')); parts = []; start = -1;
                            state = format === 'array' ? 'comma' : 'value';
                        }
                    }
                    continue;
                }
                if (c === ' ' || c === '\n' || c === '\r' || c === '\t') continue;
                if (!format) {
                    format = c === '[' ? 'array' : 'lines';
                    if (format === 'array') continue;
                }
                if (state === 'done') fail();
                if (format === 'array' && c === ']' && (state === 'comma' || state === 'value')) { state = 'done'; continue; }
                if (state === 'comma') {
                    if (c !== ',') fail();
                    state = 'required'; continue;
                }
                if (c !== '{') fail();
                start = i; depth = 1;
            }
            if (start >= 0) parts.push(text.slice(start));
        },
        finish() {
            if (depth || (format === 'array' && state !== 'done')) fail();
            return reader.finish();
        }
    };
}

function soloGameSnapshotJsonParts(parts) {
    const json = ['[\n'];
    for (let i = 0; i < parts.length; i++) json.push((i ? ',\n' : '') + parts[i].trimEnd());
    json.push('\n]\n');
    return json;
}

async function compressSoloGameSnapshot(parts) {
    return makeJsonExportBlob(soloGameSnapshotJsonParts(parts), true);
}

// Called on a fresh map with starters suppressed, on the simulation worker
// when available. Rebuild entities through today's constructors and orders.
function applySoloScene(scene) {
    const h = scene.header;
    if (GRID_W !== h.width || GRID_H !== h.height) throw new Error('The scene map dimensions do not match its settings.');
    const rows = function* (key) { for (const r of scene.records) if (r[key]) yield* r[key]; };
    for (const row of rows('units')) if (!Object.hasOwn(BASE_UNIT_STATS, row[0])) throw new Error('Unknown scene unit type: ' + row[0]);
    for (const row of rows('buildings')) if (!Object.hasOwn(BASE_CARD_TYPES, row[0])) throw new Error('Unknown scene building type: ' + row[0]);
    goldMines.length = 0; astarMines.length = 0;
    initTileEntityLookup();
    let y = 0;
    for (const runs of rows('terrain')) {
        let x = 0;
        for (let i = 0; i < runs.length; i += 4) for (let n = 0; n < runs[i+3]; n++, x++) {
            Object.assign(grid[y][x], { type: runs[i], owner: runs[i+1], areaId: runs[i+2], item: null, droppedItem: null });
            areaIdGrid[y][x] = runs[i+2];
        }
        y++;
    }
    areas = Array.from(rows('areas'), a => ({ ...a, active: false }));
    _areaById = []; for (const a of areas) _areaById[a.id] = a;
    rebuildAreaDistanceCachesFromAreas();
    for (let pid = 0; pid < h.players.length; pid++) {
        const saved = h.players[pid], p = players[pid];
        addPlayerResource(pid, 'energy', saved.energy - p.energy);
        addPlayerResource(pid, 'astar', saved.astar - p.astar);
        p.researchLevels = { ...saved.researchLevels }; p.researchMultipliers = {};
        for (const [id, level] of Object.entries(p.researchLevels)) {
            const [kind, key, stat] = id.split(':');
            if (getResearchStatEntry(kind, key, stat)) p.researchMultipliers[id] = detPow(getResearchBonusExpForStat(kind, stat, key), level);
        }
    }
    rebuildPrecomputedStatsMapPlayer();
    for (const [type, gx, gy, amount, max] of rows('mines')) {
        const m = Object.assign(type === 'energy' ? new GoldMine() : new AstarMine(), { gx, gy, x: gx*TILE+16, y: gy*TILE+16 });
        if (type === 'energy') { m.gold = amount; m.maxGold = max; goldMines.push(m); }
        else { m.astar = amount; m.maxAstar = max; astarMines.push(m); }
        setTileEntity(gx, gy, type === 'energy' ? TILE_ENTITY_GOLDMINE : TILE_ENTITY_ASTARMINE, m);
    }
    for (const r of rows('buildings')) {
        if (!placeBuilding(r[2],r[3],r[0],r[1], { silent: true, ignorePlacementRules: true, autoUpgradeEnabled: r[9], buildEnabled: r[10] }))
            throw new Error('Could not place scene building: ' + r[0]);
        const e = getTileEntityRef(r[2],r[3]) || grid[r[3]][r[2]].item;
        e.stacks = e.manualStacks = e.effectiveStacks = r[4]; e.level = e.effectiveLevel = stackCountToLevel(r[4]);
        e.underConstruction = !!r[6];
        if (typeof e.updateStats === 'function') e.updateStats();
        e.energy = r[5];
        if (r[7] != null) { e.rallyX = r[7]*TILE; e.rallyY = r[8]*TILE; }
    }
    simMoveWallsDirty(); simMoveStructsReset(); navReset();
    const groups = new Map();
    for (const r of rows('units')) {
        const u = new Unit(r[0],r[1],r[2]*TILE,r[3]*TILE);
        configureWorkerUnitFromType(u); u.baseLevel = r[5]; u.stackCount = r[6]; applyUnitLevelScaling(u,r[5]);
        u.energy = r[4]; u.holdPosition = !!r[8];
        units.push(u); unitSlotMapPushed(u); players[u.owner].popCount++;
        if (r[7] && !u.holdPosition) {
            const key = u.owner + ':' + r[7].join(':'), group = groups.get(key);
            if (group) group.unitIds.push(u.id);
            else groups.set(key, { owner: u.owner, action: r[7][0], targetX: (r[7][1]+.5)*TILE, targetY: (r[7][2]+.5)*TILE, unitIds: [u.id], distinct: true });
        }
    }
    for (const a of groups.values()) _issueGroupMoveOrder(a,a.owner,a.action === 'attackMove' ? CMD_ATTACK_MOVING : CMD_MOVING);
    recomputePlayerPopCaps(); recalculateAdjacency(true);
    clearGameplayVisibilityCache(); updateVisibility(localPlayerId);
    _markCombinedBgFullDirty();
}

async function restoreSoloGameSnapshot(scene) {
    if (gameStarted || isMultiplayer || _soloStartPreparation) throw new Error('Return to the main menu before importing a snapshot.');
    const h = scene.header;
    applyMainMenuSettingsSnapshot(h.settings);
    await prepareRendererLodAssets(true);
    try {
        isHost = false; isMultiplayer = false; gameSeed = h.seed; localPlayerId = h.player;
        activeTeamIds = h.teams.slice(); teamColorById = { ...h.teamColors };
        initAudio(); startGameSkipStarters = true;
        try { startGame(); } finally { startGameSkipStarters = false; }
        const made = simClientCreateMatch({ scene });
        if (made) { setMatchLoadOverlay(true, 'Importing scene…'); await made; }
        else applySoloScene(scene);
        Object.assign(camera, { x: h.camera.x*TILE, y: h.camera.y*TILE, zoom: h.camera.zoom }); clampCamera();
        _tickAccumulator = 0; _lastTickTime = performance.now();
        setMatchLoadOverlay(false); requestBuildMenuRefresh(); updateInfoPanel();
        showUiBanner('Scene imported. Paths and simulation state rebuilt.', 'success');
    } catch (error) {
        simClientStop(); _returnToMainMenuWithStatus('Snapshot import failed: ' + error.message, '#f66'); throw error;
    }
}

async function downloadSoloGameSnapshot(compressed = true) {
    if (_soloSnapshotExporting) return;
    _soloSnapshotExporting = true;
    const button = document.getElementById('btn-export-snapshot');
    if (button) { button.disabled = true; button.textContent = 'Exporting…'; }
    try {
        const parts = await captureSoloGameSnapshotParts();
        const blob = await makeJsonExportBlob(soloGameSnapshotJsonParts(parts), compressed);
        downloadJsonExport(blob, 'defence3-scene', compressed);
        showUiBanner('Scene snapshot download started.', 'success');
    } catch (error) { console.error('Scene snapshot export failed', error); showUiBanner('Snapshot export failed: ' + error.message, 'error', 15000); }
    finally { _soloSnapshotExporting = false; if (button) { button.disabled = false; button.textContent = 'Export Snapshot'; } }
}
function initSoloSnapshotControls() {
    const save = document.getElementById('btn-export-snapshot'), open = document.getElementById('btn-play-offline'), input = document.getElementById('input-import-snapshot');
    if (save) save.addEventListener('click', () => showExportOptions(save, downloadSoloGameSnapshot));
    if (!open || !input) return;
    open.addEventListener('click', () => showMenuActions(open, [
        { label: 'New', run: () => startSoloGame() },
        { label: 'Load', run: () => { input.value = ''; input.click(); } }
    ]));
    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file || _soloSnapshotImporting) return;
        _soloSnapshotImporting = true; open.disabled = true; open.textContent = 'Loading…';
        try { await restoreSoloGameSnapshot(await readSoloGameSnapshotFile(file)); }
        catch (error) { console.error('Scene snapshot import failed', error); showUiBanner('Snapshot import failed: ' + error.message, 'error', 15000); }
        finally { _soloSnapshotImporting = false; open.disabled = false; open.textContent = 'Play Offline'; input.value = ''; }
    });
}
