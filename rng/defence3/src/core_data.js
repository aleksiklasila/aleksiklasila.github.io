"use strict";

// ============================================================
// UTILS
// ============================================================
let activeFormatBigNumberSuffixStart = null;

function formatBigNumber(n, d = 1, suffixStart = undefined) {
    if (n == null) return "...";
    if (typeof n === 'string') return n;
    if (!Number.isFinite(n)) return '' + n;

    let decimals = Math.max(1, Math.floor(Number.isFinite(d) ? d : 1));
    let sign = n < 0 ? '-' : '';
    let abs = Math.abs(n);
    let suffixThresholdRaw = (suffixStart === undefined)
        ? activeFormatBigNumberSuffixStart
        : suffixStart;
    let suffixThreshold = Number(suffixThresholdRaw);
    if (!Number.isFinite(suffixThreshold) || suffixThreshold <= 0) suffixThreshold = 1000000;
    if (abs < suffixThreshold) return sign + abs.toFixed(decimals);

    const suffixes = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
    let tier = Math.floor(Math.log10(abs) / 3);

    if (tier >= suffixes.length) {
        let e = Math.floor(Math.log10(abs));
        return sign + 'e' + e;
    }

    let scaled = abs / Math.pow(1000, tier);

    // Handle boundary rollover (e.g. 999.995K -> 1.00M)
    let rounded = Number(scaled.toFixed(decimals));
    if (rounded >= 1000 && tier < suffixes.length - 1) {
        tier++;
        scaled = rounded / 1000;
        rounded = Number(scaled.toFixed(decimals));
    }

    let text = rounded.toFixed(decimals);
    return sign + text + suffixes[tier];
}

function getGameModeLabel(mode = gameMode) {
    return mode === 'killking' ? 'Kill King' : 'Destroy Base';
}

function getTeamDisplayColor(pid) {
    return teamColorById[pid] || PLAYER_COLORS[pid] || '#ccc';
}

function enterSpectateMode(mode = 'defeated') {
    spectateMode = mode;
    localDefeated = true;
    fullVisibility = true;
    selectedBuildItem = null;
    selectedUnits = [];
    selectedEntities = [];
    activeSubGroups = {};
    attackMoveMode = false;
    if (isMultiplayer && !isHost && gameStarted && connections[0]) {
        try { connections[0].send({ type: 'MATCH_ROLE_UPDATE', role: 'spectating' }); } catch { }
    }
    requestBuildMenuRefresh();
    updateInfoPanel();
}

function isTeamAliveByAssets(pid) {
    if (resignedTeams.has(pid)) return false;
    for (let t of towers) if (t.owner === pid) return true;
    for (let b of barracks) if (b.owner === pid) return true;
    for (let s of collectorSpawners) if (s.owner === pid) return true;
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            if (grid[y][x].item && grid[y][x].owner === pid) return true;
        }
    }
    return false;
}

function eliminateTeamAssets(pid) {
    for (let i = units.length - 1; i >= 0; i--) {
        let u = units[i];
        if (u.owner !== pid) continue;
        removeUnitSpatial(u);
        selectedUnits = selectedUnits.filter(su => su !== u);
        units.splice(i, 1);
    }
    players[pid].popCount = 0;

    for (let i = towers.length - 1; i >= 0; i--) {
        let t = towers[i];
        if (t.owner !== pid) continue;
        towers.splice(i, 1);
        clearTileEntity(t.gx, t.gy, t);
        if (grid[t.gy] && grid[t.gy][t.gx]) {
            grid[t.gy][t.gx].type = TYPE_FLOOR;
            grid[t.gy][t.gx].owner = -1;
            _markCombinedBgTileDirty(t.gx, t.gy, 0, true);
        }
    }
    for (let i = barracks.length - 1; i >= 0; i--) {
        let b = barracks[i];
        if (b.owner !== pid) continue;
        barracks.splice(i, 1);
        clearTileEntity(b.gx, b.gy, b);
        if (grid[b.gy] && grid[b.gy][b.gx]) {
            grid[b.gy][b.gx].item = null;
            grid[b.gy][b.gx].owner = -1;
        }
    }
    for (let i = collectorSpawners.length - 1; i >= 0; i--) {
        let s = collectorSpawners[i];
        if (s.owner !== pid) continue;
        collectorSpawners.splice(i, 1);
        clearTileEntity(s.gx, s.gy, s);
        if (grid[s.gy] && grid[s.gy][s.gx]) {
            grid[s.gy][s.gx].item = null;
            grid[s.gy][s.gx].owner = -1;
        }
    }
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y][x];
            if (cell.item && cell.owner === pid) {
                clearTileEntity(x, y, cell.item);
                cell.item = null;
                cell.owner = -1;
            }
        }
    }
    dirtyGrid = true;
    recalculateAdjacency();
    recalculateLaserConnections();
    updateInfoPanel();
}

function getSpawnerRallyTargetWorld(spawner) {
    if (spawner.rallyTargetUnitId != null) {
        let tu = units.find(u => u.id === spawner.rallyTargetUnitId && !u.dead && u.owner !== spawner.owner);
        if (tu) {
            let tgx = Math.floor(tu.x / TILE), tgy = Math.floor(tu.y / TILE);
            if (isTileVisibleToPlayer(spawner.owner, tgx, tgy)) {
                spawner.rallyX = tu.x;
                spawner.rallyY = tu.y;
                spawner._rallyLastSeenX = tu.x;
                spawner._rallyLastSeenY = tu.y;
                spawner._pendingRallyDetach = false;
                return { x: tu.x, y: tu.y };
            }

            let lockX = Number.isFinite(spawner._rallyLastSeenX) ? spawner._rallyLastSeenX : spawner.rallyX;
            let lockY = Number.isFinite(spawner._rallyLastSeenY) ? spawner._rallyLastSeenY : spawner.rallyY;
            if (Number.isFinite(lockX) && Number.isFinite(lockY)) {
                spawner.rallyX = lockX;
                spawner.rallyY = lockY;
            }
            // Stop following when target leaves owner's visibility.
            spawner.rallyTargetUnitId = null;
            spawner._pendingRallyDetach = false;
        }
    }
    if (spawner.rallyX !== null && spawner.rallyY !== null && Number.isFinite(spawner.rallyX) && Number.isFinite(spawner.rallyY)) {
        return { x: spawner.rallyX, y: spawner.rallyY };
    }
    return null;
}

function normalizeTowerTargetSpec(spec) {
    if (!spec || typeof spec !== 'object' || typeof spec.type !== 'string') return null;
    if (spec.type === 'unit' && Number.isFinite(spec.id)) {
        return { type: 'unit', id: Math.floor(spec.id) };
    }
    if ((spec.type === 'tower' || spec.type === 'barrack' || spec.type === 'spawner' || spec.type === 'item') && Number.isFinite(spec.gx) && Number.isFinite(spec.gy)) {
        return { type: spec.type, gx: Math.floor(spec.gx), gy: Math.floor(spec.gy) };
    }
    return null;
}

function getTowerTargetSpecFromEntity(target) {
    if (!target) return null;
    if (target instanceof Unit) return { type: 'unit', id: target.id };
    if (target instanceof Tower) return { type: 'tower', gx: target.gx, gy: target.gy };
    if (target instanceof Barrack) return { type: 'barrack', gx: target.gx, gy: target.gy };
    if ((target instanceof CollectorSpawner) || (target instanceof AstarSpawner) || (target instanceof SalvagerSpawner) || (target instanceof BuilderSpawner) || (target instanceof HealerSpawner) || (target instanceof ResearchSpawner)) {
        return { type: 'spawner', gx: target.gx, gy: target.gy };
    }
    if (Number.isFinite(target.gx) && Number.isFinite(target.gy)) {
        return { type: 'item', gx: target.gx, gy: target.gy };
    }
    return null;
}

function resolveTowerPreferredTarget(tower) {
    if (!tower || !tower.preferredTargetSpec) return null;
    let spec = normalizeTowerTargetSpec(tower.preferredTargetSpec);
    if (!spec) return null;
    if (spec.type === 'unit') {
        return units.find(u => u.id === spec.id && !u.dead && u.owner !== tower.owner) || null;
    }
    if (spec.type === 'tower') {
        let t = getTowerAtTile(spec.gx, spec.gy);
        return (t && t.energy > 0 && t.owner !== tower.owner) ? t : null;
    }
    if (spec.type === 'barrack') {
        let b = getBarrackAtTile(spec.gx, spec.gy);
        return (b && b.energy > 0 && b.owner !== tower.owner) ? b : null;
    }
    if (spec.type === 'spawner') {
        let s = getSpawnerAtTile(spec.gx, spec.gy);
        return (s && s.energy > 0 && s.owner !== tower.owner) ? s : null;
    }
    if (spec.type === 'item') {
        let item = getFloorItemAtTile(spec.gx, spec.gy);
        if (item && item.energy > 0 && item.owner !== tower.owner) return item;
    }
    return null;
}

function getTowerPreferredTargetInRange(tower, rangePx) {
    if (!tower) return null;
    let pt = tower.preferredTarget;
    if (!pt || pt.dead || (pt.energy !== undefined && pt.energy <= 0) || (pt.owner !== undefined && pt.owner === tower.owner)) {
        pt = resolveTowerPreferredTarget(tower);
    }
    if (!pt) {
        tower.preferredTarget = null;
        tower.preferredTargetSpec = null;
        return null;
    }
    let ptgx = Math.floor(pt.x / TILE), ptgy = Math.floor(pt.y / TILE);
    if (!isTileVisibleToPlayer(tower.owner, ptgx, ptgy)) {
        tower.preferredTarget = null;
        tower.preferredTargetSpec = null;
        return null;
    }
    let ptDist = Math.hypot(pt.x - tower.x, pt.y - tower.y);
    if (ptDist > rangePx) return null;
    tower.preferredTarget = pt;
    if (!tower.preferredTargetSpec) tower.preferredTargetSpec = getTowerTargetSpecFromEntity(pt);
    return pt;
}

function resolveTowerPreferredTargetVisual(tower) {
    if (!tower) return null;
    let spec = normalizeTowerTargetSpec(tower.preferredTargetSpec);
    if (!spec) return null;
    if (spec.type === 'unit') {
        let u = units.find(x => x.id === spec.id && !x.dead);
        return u ? { x: u.x, y: u.y, locked: true } : null;
    }
    if (spec.type === 'tower') {
        let t = getTowerAtTile(spec.gx, spec.gy);
        if (!(t && t.energy > 0)) t = null;
        return t ? { x: t.x, y: t.y, locked: true } : { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16, locked: false };
    }
    if (spec.type === 'barrack') {
        let b = getBarrackAtTile(spec.gx, spec.gy);
        if (!(b && b.energy > 0)) b = null;
        return b ? { x: b.x, y: b.y, locked: true } : { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16, locked: false };
    }
    if (spec.type === 'spawner') {
        let s = getSpawnerAtTile(spec.gx, spec.gy);
        if (!(s && s.energy > 0)) s = null;
        return s ? { x: s.x, y: s.y, locked: true } : { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16, locked: false };
    }
    if (spec.type === 'item') {
        let item = getFloorItemAtTile(spec.gx, spec.gy);
        if (!(item && item.energy > 0)) item = null;
        return item ? { x: item.x, y: item.y, locked: true } : { x: spec.gx * TILE + 16, y: spec.gy * TILE + 16, locked: false };
    }
    return null;
}

function getTowerPreferredTargetDisplay(tower) {
    let spec = normalizeTowerTargetSpec(tower && tower.preferredTargetSpec);
    if (!spec) return 'None';
    if (spec.type === 'unit') {
        let u = units.find(x => x.id === spec.id && !x.dead);
        if (u) return `Unit ${u.id} (${Math.floor(u.x / TILE)},${Math.floor(u.y / TILE)})`;
        return `Unit ${spec.id}`;
    }
    let label = spec.type === 'tower' ? 'Tower' : spec.type === 'barrack' ? 'Barrack' : spec.type === 'spawner' ? 'Spawner' : 'Item';
    return `${label} (${spec.gx},${spec.gy})`;
}

function countTeamUnits(pid) {
    let owner = Math.floor(Number(pid));
    if (owner >= 0 && owner < spatialUnitsComplexPlayerCount && spatialUnitsComplexStridePerChunk > 0 && spatialUnitsComplexStridePerPlayer > 0 && spatialUnitsComplex.length > 0) {
        let n = 0;
        let chunkCount = CHUNKS_W * CHUNKS_H;
        for (let chunkKey = 0; chunkKey < chunkCount; chunkKey++) {
            let playerBase = (chunkKey * spatialUnitsComplexStridePerChunk) + (owner * spatialUnitsComplexStridePerPlayer);
            n += spatialUnitsComplex[playerBase] || 0;
        }
        return n;
    }
    let fallback = 0;
    for (let u of units) if (u.owner === pid && !u.dead) fallback++;
    return fallback;
}

function countTeamStructures(pid) {
    let n = 0;
    for (let t of towers) if (t.owner === pid && t.energy > 0) n++;
    for (let b of barracks) if (b.owner === pid && b.energy > 0) n++;
    for (let s of collectorSpawners) if (s.owner === pid && s.energy > 0) n++;
    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let item = grid[y][x].item;
            if (item && grid[y][x].owner === pid && item.energy > 0) n++;
        }
    }
    return n;
}

function sampleGameStats() {
    if (!gameStarted) return;
    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];
    let sample = { tick: gameTime, energy: {}, pop: {}, units: {}, structures: {} };
    for (let pid of teams) {
        sample.energy[pid] = players[pid] ? players[pid].energy : 0;
        sample.pop[pid] = players[pid] ? players[pid].popCount : 0;
        sample.units[pid] = countTeamUnits(pid);
        sample.structures[pid] = countTeamStructures(pid);
    }
    gameStatsHistory.push(sample);
    if (gameStatsHistory.length > 3600) gameStatsHistory.shift();
}

function renderGameGraph(metric = graphMetric) {
    graphMetric = 'units';
    metric = 'units';
    let plotEl = document.getElementById('go-graph-plot');
    if (!plotEl || typeof Plotly === 'undefined') return;
    let samples = gameStatsHistory;
    if (!samples || samples.length === 0) {
        Plotly.react(plotEl, [], {
            paper_bgcolor: '#0d0d0d',
            plot_bgcolor: '#0d0d0d',
            xaxis: { visible: false },
            yaxis: { visible: false },
            annotations: [{ text: 'No graph data recorded.', x: 0.5, y: 0.5, showarrow: false, font: { color: '#999', size: 14 } }],
            margin: { l: 24, r: 24, t: 20, b: 20 }
        }, { displayModeBar: false, responsive: true });
        return;
    }

    let teams = (activeTeamIds && activeTeamIds.length > 0) ? activeTeamIds : [0, 1];

    let traces = teams.map(pid => ({
        x: samples.map(s => (s.tick || 0) / TICK_RATE),
        y: samples.map(s => (s[metric] && s[metric][pid]) || 0),
        mode: 'lines',
        name: `P${pid + 1}`,
        line: { color: getTeamDisplayColor(pid), width: 2 }
    }));

    let maxSeconds = (samples[samples.length - 1].tick || 0) / TICK_RATE;
    Plotly.react(plotEl, traces, {
        paper_bgcolor: '#0d0d0d',
        plot_bgcolor: '#0d0d0d',
        font: { color: '#cfd8dc', family: 'monospace', size: 11 },
        margin: { l: 48, r: 12, t: 26, b: 36 },
        legend: { orientation: 'h', x: 0, y: 1.15 },
        xaxis: {
            title: 'Time (s)',
            range: [0, Math.max(10, maxSeconds)],
            gridcolor: '#2a2a2a',
            zerolinecolor: '#333'
        },
        yaxis: {
            title: 'UNITS',
            rangemode: 'tozero',
            gridcolor: '#2a2a2a',
            zerolinecolor: '#333'
        }
    }, {
        displayModeBar: false,
        responsive: true
    });
}

let activeHelpTab = 'keybinds';

function setHelpTab(tabId) {
    activeHelpTab = tabId || 'keybinds';
    let popup = document.getElementById('help-popup');
    if (!popup) return;
    popup.querySelectorAll('.help-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === activeHelpTab);
    });
    popup.querySelectorAll('.help-tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.tabPanel === activeHelpTab);
    });
}

function setHelpPopupOpen(open) {
    let popup = document.getElementById('help-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    if (open) {
        let modeEl = document.getElementById('help-game-mode');
        if (modeEl) modeEl.textContent = getGameModeLabel(gameMode);
        setHelpTab('keybinds');
    }
    popup.classList.toggle('hidden', !open);
    return wasOpen !== open;
}

function getOwnedActiveResearchLabs(owner) {
    return collectorSpawners.filter(s => s && s.type === 'research' && s.owner === owner && s.energy > 0 && !s.underConstruction);
}

function setResearchQueueDragGuard(active, rerenderPopup = false) {
    let wasActive = researchQueueDragInProgress;
    researchQueueDragInProgress = !!active;
    if (wasActive && !researchQueueDragInProgress && rerenderPopup) {
        let researchPopup = document.getElementById('research-popup');
        if (researchPopup && !researchPopup.classList.contains('hidden')) {
            renderResearchPopupContent();
        }
    }
}

function ensureResearchQueueDragReleaseHooks() {
    if (researchQueueDragReleaseHooksBound) return;
    researchQueueDragReleaseHooksBound = true;
    window.addEventListener('mouseup', () => setResearchQueueDragGuard(false, true), true);
    window.addEventListener('dragend', () => setResearchQueueDragGuard(false, true), true);
    window.addEventListener('blur', () => setResearchQueueDragGuard(false, false), true);
}

function renderResearchPopupContent() {
    let holder = document.getElementById('research-popup-content');
    if (!holder) return;
    let popupSnapshot = null;
    if (activePopupControlGroupKey) {
        normalizePopupControlGroup(activePopupControlGroupKey);
        popupSnapshot = getPopupControlGroupSnapshot(activePopupControlGroupKey);
        if (!popupSnapshot) activePopupControlGroupKey = '';
    }

    let unitsSnapshot = popupSnapshot
        ? (popupSnapshot.units || []).filter(u => u && !u.dead)
        : selectedUnits.filter(u => u && !u.dead);
    let entitiesSnapshot = popupSnapshot
        ? (popupSnapshot.entities || []).filter(e => e && !(e.energy !== undefined && e.energy <= 0))
        : selectedEntities.filter(e => e && !(e.energy !== undefined && e.energy <= 0));
    let subgroupSnapshot = popupSnapshot
        ? { ...(popupSnapshot.activeSubGroups || {}) }
        : { ...activeSubGroups };

    let infoPanel = holder.querySelector('#research-popup-info-panel');
    if (!infoPanel) {
        holder.innerHTML = `
        <div id="queue-multiplier-bar-popup" class="mult-toggle-bar" style="padding:3px 4px;border-bottom:1px solid #2a2a2a;background:#101010;"></div>
        <div class="subgroup-options-popup" style="display:flex;gap:4px;padding:3px 4px;border-bottom:1px solid #2a2a2a;background:#101010;margin-bottom:4px;">
            <button id="btn-ignore-level-popup">Collapse Same Type: OFF</button>
        </div>
        <div id="research-popup-info-panel"></div>
    `;
        infoPanel = holder.querySelector('#research-popup-info-panel');
        updatePurchaseMultiplierBars();
    }

    let popupIgnoreBtn = holder.querySelector('#btn-ignore-level-popup');
    if (popupIgnoreBtn && popupIgnoreBtn.dataset.bound !== '1') {
        popupIgnoreBtn.dataset.bound = '1';
        bindInstantPress(popupIgnoreBtn, () => {
            ignoreLevelSubgroups = !ignoreLevelSubgroups;
            updateIgnoreLevelButton();
            if (activePopupControlGroupKey) {
                normalizePopupControlGroup(activePopupControlGroupKey);
                let snap = getPopupControlGroupSnapshot(activePopupControlGroupKey);
                if (snap) snap.activeSubGroups = {};
            }
            renderResearchPopupContent();
            updateInfoPanel();
        });
    }

    let prevUnits = selectedUnits;
    let prevEntities = selectedEntities;

    selectedUnits = unitsSnapshot;
    selectedEntities = entitiesSnapshot;
    updateInfoPanel(infoPanel, {
        skipGlobalSync: true,
        subgroupState: subgroupSnapshot,
        onRefresh: () => {
            if (!researchQueueDragInProgress) renderResearchPopupContent();
        },
        onSubgroupStateChange: (nextState) => {
            subgroupSnapshot = { ...(nextState || {}) };
            if (popupSnapshot) popupSnapshot.activeSubGroups = { ...subgroupSnapshot };
        }
    });

    selectedUnits = prevUnits;
    selectedEntities = prevEntities;
    updateIgnoreLevelButton();
}

function setResearchPopupOpen(open) {
    let popup = document.getElementById('research-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    if (open) renderResearchPopupContent();
    popup.classList.toggle('hidden', !open);
    if (!open) {
        activePopupControlGroupKey = '';
        setResearchQueueDragGuard(false, false);
    }
    return wasOpen !== open;
}

function refreshStatsMapPopupText() {
    ensurePrecomputedStatsMap();
    let ta = document.getElementById('statsmap-json');
    if (!ta) return;
    try {
        ta.value = JSON.stringify(PRECOMPUTED_STATS_MAP, null, 2);
    } catch {
        ta.value = '{"error":"Unable to serialize PRECOMPUTED_STATS_MAP"}';
    }
    ta.scrollTop = 0;
}

function setStatsMapPopupOpen(open) {
    let popup = document.getElementById('statsmap-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    if (open) refreshStatsMapPopupText();
    return wasOpen !== open;
}

function buildResearchStatMatrixGrid(kind, key, statKey) {
    let grid = [];
    let header = [''];
    for (let rl = 0; rl <= MAX_RESEARCH_LEVEL; rl++) header.push(`R${rl}`);
    grid.push(header);

    for (let tl = 1; tl <= MAX_THING_LEVEL; tl++) {
        let row = [`L${tl}`];
        for (let rl = 0; rl <= MAX_RESEARCH_LEVEL; rl++) {
            let v = getResearchStatValueAtLevel(kind, key, statKey, rl, tl);
            row.push(formatResearchStatValue(statKey, v));
        }
        grid.push(row);
    }

    return grid;
}

function formatShopStatMatrixCellValue(value, statKey = '') {
    if (Number.isFinite(value)) {
        if (statKey) return formatResearchStatValue(statKey, value);
        return formatBigNumber(value, 2);
    }
    if (value === null || value === undefined) return '-';
    return String(value);
}

function buildStatMatrixGridFromDescriptor(d) {
    if (!d) return null;

    let grid = [];
    let header = [''];
    for (let rl = 0; rl <= MAX_RESEARCH_LEVEL; rl++) header.push(`R${rl}`);
    grid.push(header);

    for (let tl = 1; tl <= MAX_THING_LEVEL; tl++) {
        let row = [`L${tl}`];
        for (let rl = 0; rl <= MAX_RESEARCH_LEVEL; rl++) {
            let raw = null;
            if (typeof d.getValue === 'function') {
                raw = d.getValue(tl, rl);
            } else if (d.kind && d.key && d.statKey) {
                let hasResearchEntry = !!getResearchStatEntry(d.kind, d.key, d.statKey);
                let useRl = hasResearchEntry ? rl : 0;
                raw = d.kind === 'unit'
                    ? getUnitStatFromMap(d.key, tl, d.statKey, useRl)
                    : getBuildingStatFromMap(d.key, tl, d.statKey, useRl);
            } else {
                raw = d.fixedValue;
            }
            row.push(formatShopStatMatrixCellValue(raw, d.statKey || ''));
        }
        grid.push(row);
    }

    return grid;
}

function buildShopStatMatrixGrid(matrixId) {
    let d = shopStatMatrixDescriptorById[matrixId];
    return buildStatMatrixGridFromDescriptor(d);
}

function buildInfoPanelStatMatrixGrid(matrixId) {
    let d = infoPanelStatMatrixDescriptorById[matrixId];
    return buildStatMatrixGridFromDescriptor(d);
}

function _escapeHtml(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderMatrixGridToPopup(grid, emptyText = 'No matrix data.') {
    let container = document.getElementById('research-matrix-json');
    if (!container) return;
    if (!Array.isArray(grid) || grid.length === 0 || !Array.isArray(grid[0]) || grid[0].length === 0) {
        container.innerHTML = `<div class="matrix-empty">${_escapeHtml(emptyText)}</div>`;
        return;
    }

    let html = '<table class="matrix-table"><thead><tr>';
    let head = grid[0];
    for (let i = 0; i < head.length; i++) {
        if (i === 0) html += `<th class="matrix-row-head">${_escapeHtml(head[i])}</th>`;
        else html += `<th>${_escapeHtml(head[i])}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let r = 1; r < grid.length; r++) {
        let row = grid[r] || [];
        html += '<tr>';
        for (let c = 0; c < row.length; c++) {
            if (c === 0) html += `<th class="matrix-row-head">${_escapeHtml(row[c])}</th>`;
            else html += `<td>${_escapeHtml(row[c])}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
    container.scrollTop = 0;
    container.scrollLeft = 0;
}

function refreshResearchStatMatrixPopupText() {
    let ta = document.getElementById('research-matrix-json');
    let title = document.getElementById('research-matrix-title');
    if (!ta) return;
    let p = researchStatMatrixPopupPayload;
    if (!p) {
        renderMatrixGridToPopup(null, '{"error":"No stat selected"}');
        if (title) title.textContent = 'Research Stat Matrix';
        return;
    }
    try {
        if (Number.isFinite(Number(p.shopMatrixId))) {
            let d = shopStatMatrixDescriptorById[p.shopMatrixId];
            if (title) title.textContent = d && d.title ? `Research Stat Matrix: ${d.title}` : 'Research Stat Matrix';
            renderMatrixGridToPopup(buildShopStatMatrixGrid(Number(p.shopMatrixId)), 'No stat descriptor found.');
        } else if (Number.isFinite(Number(p.infoPanelMatrixId))) {
            let d = infoPanelStatMatrixDescriptorById[p.infoPanelMatrixId];
            if (title) title.textContent = d && d.title ? `Research Stat Matrix: ${d.title}` : 'Research Stat Matrix';
            renderMatrixGridToPopup(buildInfoPanelStatMatrixGrid(Number(p.infoPanelMatrixId)), 'No stat descriptor found.');
        } else {
            if (title) title.textContent = `Research Stat Matrix: ${p.kind}:${p.key}:${p.statKey}`;
            renderMatrixGridToPopup(buildResearchStatMatrixGrid(p.kind, p.key, p.statKey));
        }
    } catch {
        renderMatrixGridToPopup(null, 'Unable to build matrix');
    }
}

function setResearchStatMatrixPopupOpen(open) {
    let popup = document.getElementById('research-matrix-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    if (open) refreshResearchStatMatrixPopupText();
    return wasOpen !== open;
}

function makeDefaultStartingResourcesConfig() {
    return {
        researchLevels: {},
        spawnCounts: {
            'building:astar_spawner': { 1: 1 },
            'unit:astar_collector': { 1: 1 },
        }
    };
}

function cloneStartingResourcesConfig() {
    return {
        researchLevels: { ...(startingResourcesConfig.researchLevels || {}) },
        spawnCounts: JSON.parse(JSON.stringify(startingResourcesConfig.spawnCounts || {}))
    };
}

function parseStartingThingId(id) {
    let text = String(id || '');
    let sep = text.indexOf(':');
    if (sep < 1) return null;
    let kind = text.slice(0, sep);
    let key = text.slice(sep + 1);
    if ((kind !== 'unit' && kind !== 'building') || !key) return null;
    return { kind, key };
}

function getStartingThingId(kind, key) {
    return `${kind}:${key}`;
}

function normalizeStartingResourcesConfig(rawCfg) {
    let raw = (rawCfg && typeof rawCfg === 'object') ? rawCfg : {};
    let out = makeDefaultStartingResourcesConfig();

    if (raw.researchLevels && typeof raw.researchLevels === 'object') {
        for (let id in raw.researchLevels) {
            let parsed = parseStartingThingId(id);
            if (!parsed) continue;
            let thing = getResearchThing(parsed.kind, parsed.key);
            if (!thing) continue;
            let levelMap = raw.researchLevels[id];
            if (typeof levelMap === 'object' && levelMap !== null) {
                for (let statKey in levelMap) {
                    if (!getResearchStatEntry(parsed.kind, parsed.key, statKey)) continue;
                    let lvl = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(levelMap[statKey]) || 0)));
                    if (!out.researchLevels[id]) out.researchLevels[id] = {};
                    if (lvl > 0) out.researchLevels[id][statKey] = lvl;
                }
                if (out.researchLevels[id] && Object.keys(out.researchLevels[id]).length === 0) delete out.researchLevels[id];
            }
        }
    }

    if (raw.spawnCounts && typeof raw.spawnCounts === 'object') {
        for (let id in raw.spawnCounts) {
            let parsed = parseStartingThingId(id);
            if (!parsed) continue;
            let thing = getResearchThing(parsed.kind, parsed.key);
            if (!thing) continue;
            let countMap = raw.spawnCounts[id];
            if (typeof countMap === 'object' && countMap !== null) {
                for (let levelText in countMap) {
                    let level = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(levelText) || 0)));
                    let count = Math.max(0, Math.min(1000, Math.floor(Number(countMap[levelText]) || 0)));
                    if (!out.spawnCounts[id]) out.spawnCounts[id] = {};
                    if (count > 0) out.spawnCounts[id][level] = count;
                }
                if (out.spawnCounts[id] && Object.keys(out.spawnCounts[id]).length === 0) delete out.spawnCounts[id];
            }
        }
    }

    return out;
}

function resetStartingResourcesConfig() {
    startingResourcesConfig = normalizeStartingResourcesConfig(makeDefaultStartingResourcesConfig());
}

function ensureStartingResourcesSelectedThing() {
    let parsed = parseStartingThingId(startingResourcesSelectedThingId);
    if (parsed && getResearchThing(parsed.kind, parsed.key)) return;
    let first = RESEARCH_THINGS[0];
    if (!first) {
        startingResourcesSelectedThingId = '';
        return;
    }
    startingResourcesSelectedThingId = getStartingThingId(first.kind, first.key);
}

function setStartingResearchLevel(thingId, statKey, value) {
    let lvl = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(value) || 0)));
    if (!startingResourcesConfig.researchLevels[thingId]) startingResourcesConfig.researchLevels[thingId] = {};
    if (lvl <= 0) {
        delete startingResourcesConfig.researchLevels[thingId][statKey];
        if (Object.keys(startingResourcesConfig.researchLevels[thingId]).length <= 0) {
            delete startingResourcesConfig.researchLevels[thingId];
        }
        return;
    }
    startingResourcesConfig.researchLevels[thingId][statKey] = lvl;
}

function setStartingSpawnCount(thingId, level, value) {
    let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 1)));
    let count = Math.max(0, Math.min(1000, Math.floor(Number(value) || 0)));
    if (!startingResourcesConfig.spawnCounts[thingId]) startingResourcesConfig.spawnCounts[thingId] = {};
    if (count <= 0) {
        delete startingResourcesConfig.spawnCounts[thingId][lvl];
        if (Object.keys(startingResourcesConfig.spawnCounts[thingId]).length <= 0) {
            delete startingResourcesConfig.spawnCounts[thingId];
        }
        return;
    }
    startingResourcesConfig.spawnCounts[thingId][lvl] = count;
}

function getStartingResourcesMaxPopulation() {
    let el = document.getElementById('cfg-max-pop');
    if (el) return Math.max(1, Math.floor(Number(el.value) || 200));
    return Math.max(1, Math.floor(Number(CONFIG_MAX_POP) || 200));
}

function getStartingResourcesTotalSpawnCount() {
    let total = 0;
    let map = (startingResourcesConfig && startingResourcesConfig.spawnCounts) || {};
    for (let thingId in map) {
        let parsed = parseStartingThingId(thingId);
        if (!parsed || parsed.kind !== 'unit') continue;
        let lvlMap = map[thingId] || {};
        for (let lvl in lvlMap) total += Math.max(0, Math.floor(Number(lvlMap[lvl]) || 0));
    }
    return total;
}

function getStartingSpawnCount(thingId, level) {
    let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 1)));
    let map = (startingResourcesConfig.spawnCounts && startingResourcesConfig.spawnCounts[thingId]) || {};
    return Math.max(0, Math.floor(Number(map[lvl]) || 0));
}

function getStartingSpawnMaxForRow(thingId, level) {
    let parsed = parseStartingThingId(thingId);
    if (!parsed || parsed.kind !== 'unit') return 1000;
    let maxPop = getStartingResourcesMaxPopulation();
    let current = getStartingSpawnCount(thingId, level);
    let total = getStartingResourcesTotalSpawnCount();
    return Math.max(0, maxPop - Math.max(0, total - current));
}

function adjustStartingResearchLevelDelta(thingId, statKey, delta) {
    let parsed = parseStartingThingId(thingId);
    if (!parsed) return;
    if (!getResearchStatEntry(parsed.kind, parsed.key, statKey)) return;
    let cur = 0;
    if (startingResourcesConfig.researchLevels[thingId] && Number.isFinite(startingResourcesConfig.researchLevels[thingId][statKey])) {
        cur = Math.floor(startingResourcesConfig.researchLevels[thingId][statKey]);
    }
    let next = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, cur + Math.floor(Number(delta) || 0)));
    setStartingResearchLevel(thingId, statKey, next);
}

function adjustStartingSpawnCountDelta(thingId, level, delta) {
    let lvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 1)));
    let cur = getStartingSpawnCount(thingId, lvl);
    let maxRow = getStartingSpawnMaxForRow(thingId, lvl);
    let next = Math.max(0, Math.min(maxRow, cur + Math.floor(Number(delta) || 0)));
    setStartingSpawnCount(thingId, lvl, next);
}

function renderStartingResourcesThingRowsForPanel() {
    ensureStartingResourcesSelectedThing();
    let selectedThing = RESEARCH_THINGS_BY_ID[startingResourcesSelectedThingId];
    if (!selectedThing) return '<div style="font-size:11px;color:#777">No thing selected.</div>';

    let owner = localPlayerId;
    let thingId = getStartingThingId(selectedThing.kind, selectedThing.key);
    let html = '';

    html += `<div class="info-row" style="display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start">`;
    for (let thing of RESEARCH_THINGS) {
        let id = `${thing.kind}:${thing.key}`;
        let isSelected = id === thingId;
        let borderRadius = thing.kind === 'unit' ? '50%' : '4px';
        html += `<button class="info-research-thing-btn info-startres-thing-btn" data-thing-id="${id}" title="${thing.label}" style="width:32px;height:32px;padding:0;border:2px solid ${isSelected ? '#8cf' : '#333'};border-radius:${borderRadius};background:${isSelected ? '#1a2730' : '#111'};cursor:pointer;display:flex;align-items:center;justify-content:center">`;
        html += `<img src="${getItemThumbnail(thing.key, 24)}" width="24" height="24" style="display:block;${thing.kind === 'unit' ? 'border-radius:50%;' : ''}">`;
        html += `</button>`;
    }
    html += `</div>`;

    html += `<div style="margin-top:4px;border:1px solid #2f2f2f;border-radius:4px;padding:4px;background:#121212">`;
    html += `<div style="font-size:10px;color:#ddd;margin-bottom:3px">${selectedThing.label}</div>`;

    for (let stat of (selectedThing.stats || [])) {
        let curLevel = 0;
        if (startingResourcesConfig.researchLevels[thingId] && Number.isFinite(startingResourcesConfig.researchLevels[thingId][stat.statKey])) {
            curLevel = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(startingResourcesConfig.researchLevels[thingId][stat.statKey]) || 0)));
        }
        let nextLevel = Math.min(MAX_RESEARCH_LEVEL, curLevel + 1);

        let selectedThingLevel = getResearchPreviewThingLevel();
        let currentValue = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, curLevel, selectedThingLevel);
        let projectedValue = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, nextLevel, selectedThingLevel);
        if (!Number.isFinite(projectedValue)) projectedValue = currentValue;

        html += `<div style="margin:2px 0 6px 0;padding:3px 4px;border:1px solid #242424;border-radius:4px;background:#101010">`;
        html += `<div style="display:flex;align-items:center;gap:8px;white-space:nowrap">`;
        html += `<span style="color:#bbb;flex:1 1 0;min-width:0">${stat.label}</span><span class="info-research-level-preview-btn info-startres-level-preview-btn" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" data-from-level="${curLevel}" data-to-level="${nextLevel}" style="color:#8fc;background:#000;cursor:pointer;flex:0 0 180px;text-align:center;display:inline-block;">${formatResearchStatValue(stat.statKey, currentValue)}->${formatResearchStatValue(stat.statKey, projectedValue)}</span>`;
        html += `<span style="color:#9cf;flex:1 1 0;text-align:right">R${curLevel}/${MAX_RESEARCH_LEVEL}</span>`;
        html += `</div>`;
        html += `<div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:2px">`;
        html += `<span class="info-startres-stat-dec" data-thing-id="${thingId}" data-stat-key="${stat.statKey}" style="cursor:${curLevel > 0 ? 'pointer' : 'default'};color:${curLevel > 0 ? '#f66' : '#444'};font-weight:bold;">[-]</span>`;
        html += `<span class="info-startres-stat-inc" data-thing-id="${thingId}" data-stat-key="${stat.statKey}" style="cursor:${curLevel < MAX_RESEARCH_LEVEL ? 'pointer' : 'default'};color:${curLevel < MAX_RESEARCH_LEVEL ? '#4f4' : '#444'};font-weight:bold;">[+]</span>`;
        html += `</div>`;
        html += `</div>`;
    }

    html += `<div style="margin-top:4px;padding-top:4px;border-top:1px solid #2c2c2c">`;
    html += `<div style="font-size:10px;color:#8cf;margin-bottom:3px">Starting Spawn Counts (Per Level)</div>`;
    for (let lvl = 1; lvl <= MAX_THING_LEVEL; lvl++) {
        let cur = getStartingSpawnCount(thingId, lvl);
        let maxRow = getStartingSpawnMaxForRow(thingId, lvl);
        html += `<div class="info-row" style="align-items:center;gap:8px;margin:1px 0;">`;
        html += `<span style="color:#bbb;flex:1 1 0">L${lvl}</span>`;
        html += `<span style="color:#fff;flex:0 0 180px;text-align:center">${cur}/${maxRow}</span>`;
        html += `<div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:1 1 0">`;
        html += `<span class="info-startres-spawn-dec" data-thing-id="${thingId}" data-level="${lvl}" style="cursor:${cur > 0 ? 'pointer' : 'default'};color:${cur > 0 ? '#f66' : '#444'};font-weight:bold;">[-]</span>`;
        html += `<span class="info-startres-spawn-inc" data-thing-id="${thingId}" data-level="${lvl}" style="cursor:${cur < maxRow ? 'pointer' : 'default'};color:${cur < maxRow ? '#4f4' : '#444'};font-weight:bold;">[+]</span>`;
        html += `</div>`;
        html += `</div>`;
    }
    html += `</div>`;

    html += `</div>`;
    return html;
}

function renderStartingResourcesPopupContent() {
    let holder = document.getElementById('starting-resources-content');
    if (!holder) return;
    holder.innerHTML = `
        <div style="font-size:10px;color:#8cf;margin-bottom:2px">Adjust Step</div>
        <div id="starting-resources-multiplier-bar" class="mult-toggle-bar" style="margin-bottom:6px;border:1px solid #2f2f2f;border-radius:4px;"></div>
        <div id="starting-resources-panel" style="display:block">${renderStartingResourcesThingRowsForPanel()}</div>
        <div class="info-row" style="justify-content:flex-end;gap:8px;margin-top:6px;border-top:1px solid #2b2b2b;padding-top:6px;">
            <button id="btn-startres-reset-selected" type="button" style="font-size:11px;padding:3px 8px;">Reset Selected Thing</button>
            <button id="btn-startres-reset-all" type="button" style="font-size:11px;padding:3px 8px;">Reset All</button>
        </div>
    `;

    renderMultiplierBar('starting-resources-multiplier-bar', startingResourcesAdjustMultiplier, (val) => {
        startingResourcesAdjustMultiplier = val;
        renderStartingResourcesPopupContent();
    });

    let resetSelected = document.getElementById('btn-startres-reset-selected');
    if (resetSelected) {
        bindInstantPress(resetSelected, () => {
            let selectedThingId = startingResourcesSelectedThingId;
            if (!selectedThingId) return;
            delete startingResourcesConfig.researchLevels[selectedThingId];
            delete startingResourcesConfig.spawnCounts[selectedThingId];
            renderStartingResourcesPopupContent();
        });
    }

    let resetAll = document.getElementById('btn-startres-reset-all');
    if (resetAll) {
        bindInstantPress(resetAll, () => {
            if (!confirm('Reset all starting resources and research presets?')) return;
            resetStartingResourcesConfig();
            renderStartingResourcesPopupContent();
        });
    }

    holder.querySelectorAll('.info-startres-thing-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let thingId = String(btn.dataset.thingId || '');
            if (!thingId) return;
            startingResourcesSelectedThingId = thingId;
            renderStartingResourcesPopupContent();
        });
    });

    holder.querySelectorAll('.info-startres-level-preview-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let kind = btn.dataset.kind;
            let key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            let fromLevel = Number.parseInt(btn.dataset.fromLevel, 10);
            let toLevel = Number.parseInt(btn.dataset.toLevel, 10);
            openResearchThingLevelDropdown(btn, { kind, key, statKey, fromLevel, toLevel });
        });
    });

    holder.querySelectorAll('.info-startres-stat-dec').forEach(btn => {
        bindInstantPress(btn, () => {
            let thingId = String(btn.dataset.thingId || '');
            let statKey = String(btn.dataset.statKey || '');
            adjustStartingResearchLevelDelta(thingId, statKey, -startingResourcesAdjustMultiplier);
            renderStartingResourcesPopupContent();
        });
    });

    holder.querySelectorAll('.info-startres-stat-inc').forEach(btn => {
        bindInstantPress(btn, () => {
            let thingId = String(btn.dataset.thingId || '');
            let statKey = String(btn.dataset.statKey || '');
            adjustStartingResearchLevelDelta(thingId, statKey, startingResourcesAdjustMultiplier);
            renderStartingResourcesPopupContent();
        });
    });

    holder.querySelectorAll('.info-startres-spawn-dec').forEach(btn => {
        bindInstantPress(btn, () => {
            let thingId = String(btn.dataset.thingId || '');
            let lvl = Number(btn.dataset.level || 1);
            adjustStartingSpawnCountDelta(thingId, lvl, -startingResourcesAdjustMultiplier);
            renderStartingResourcesPopupContent();
        });
    });

    holder.querySelectorAll('.info-startres-spawn-inc').forEach(btn => {
        bindInstantPress(btn, () => {
            let thingId = String(btn.dataset.thingId || '');
            let lvl = Number(btn.dataset.level || 1);
            adjustStartingSpawnCountDelta(thingId, lvl, startingResourcesAdjustMultiplier);
            renderStartingResourcesPopupContent();
        });
    });
}

function setStartingResourcesPopupOpen(open) {
    let popup = document.getElementById('starting-resources-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    if (open) renderStartingResourcesPopupContent();
    return wasOpen !== open;
}

let defaultEditableRuntimeConfigSnapshot = null;
let uiBannerHideTimer = null;

function showUiBanner(message, kind = 'info', timeoutMs = 2400) {
    let text = String(message || '').trim();
    if (!text) return;

    let el = document.getElementById('ui-banner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'ui-banner';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.style.position = 'fixed';
        el.style.left = '50%';
        el.style.bottom = '14px';
        el.style.transform = 'translateX(-50%) translateY(12px)';
        el.style.padding = '8px 12px';
        el.style.borderRadius = '6px';
        el.style.fontSize = '12px';
        el.style.border = '1px solid #444';
        el.style.background = '#141414';
        el.style.color = '#ddd';
        el.style.boxShadow = '0 6px 20px rgba(0,0,0,0.35)';
        el.style.zIndex = '99999';
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        el.style.transition = 'opacity 140ms ease, transform 140ms ease';
        document.body.appendChild(el);
    }

    if (kind === 'error') {
        el.style.background = '#2a1010';
        el.style.borderColor = '#8a3232';
        el.style.color = '#ffd6d6';
    } else if (kind === 'success') {
        el.style.background = '#102514';
        el.style.borderColor = '#2f7a3f';
        el.style.color = '#d8ffe0';
    } else {
        el.style.background = '#141414';
        el.style.borderColor = '#444';
        el.style.color = '#ddd';
    }

    el.textContent = text;
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';

    if (uiBannerHideTimer) clearTimeout(uiBannerHideTimer);
    uiBannerHideTimer = setTimeout(() => {
        let bannerEl = document.getElementById('ui-banner');
        if (!bannerEl) return;
        bannerEl.style.opacity = '0';
        bannerEl.style.transform = 'translateX(-50%) translateY(12px)';
    }, Math.max(800, Math.floor(Number(timeoutMs) || 2400)));
}

function cloneJsValue(value) {
    if (Array.isArray(value)) return value.map(v => cloneJsValue(v));
    if (typeof value === 'function') return value;
    if (value && typeof value === 'object') {
        let out = {};
        for (let k in value) out[k] = cloneJsValue(value[k]);
        return out;
    }
    return value;
}

function replaceObjectContents(target, source) {
    if (!target || typeof target !== 'object') return;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (let k of Object.keys(target)) delete target[k];
    for (let k of Object.keys(source)) target[k] = cloneJsValue(source[k]);
}

function replaceArrayContents(target, source) {
    if (!Array.isArray(target) || !Array.isArray(source)) return;
    target.length = 0;
    for (let item of source) target.push(cloneJsValue(item));
}

function stringifyJsLike(value, depth = 0) {
    const pad = '  '.repeat(depth);
    const nextPad = '  '.repeat(depth + 1);

    if (typeof value === 'function') return value.toString();
    if (value === null) return 'null';
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';

    let t = typeof value;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(value);
    if (t === 'string') return JSON.stringify(value);
    if (t === 'undefined') return 'undefined';

    if (Array.isArray(value)) {
        if (value.length <= 0) return '[]';
        let parts = value.map(v => `${nextPad}${stringifyJsLike(v, depth + 1)}`);
        return `[\n${parts.join(',\n')}\n${pad}]`;
    }

    if (value && t === 'object') {
        let keys = Object.keys(value);
        if (keys.length <= 0) return '{}';
        let parts = keys.map(k => `${nextPad}${JSON.stringify(k)}: ${stringifyJsLike(value[k], depth + 1)}`);
        return `{\n${parts.join(',\n')}\n${pad}}`;
    }

    return 'null';
}

function parseConfigEditorObject(text) {
    let src = String(text || '').trim();
    if (!src) throw new Error('Config editor is empty.');
    let obj = (new Function('"use strict"; return (' + src + ');'))();
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('Config must evaluate to an object literal.');
    }
    return obj;
}

function encodeFunctionsForTransport(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
        if (Number.isNaN(value)) return { __specialNumber__: 'NaN' };
        if (value === Infinity) return { __specialNumber__: 'Infinity' };
        if (value === -Infinity) return { __specialNumber__: '-Infinity' };
    }
    if (typeof value === 'function') return { __fn__: value.toString() };
    if (Array.isArray(value)) return value.map(v => encodeFunctionsForTransport(v));
    if (value && typeof value === 'object') {
        let out = {};
        for (let k in value) out[k] = encodeFunctionsForTransport(value[k]);
        return out;
    }
    return value;
}

function decodeFunctionsFromTransport(value) {
    if (Array.isArray(value)) return value.map(v => decodeFunctionsFromTransport(v));
    if (value && typeof value === 'object') {
        if (Object.keys(value).length === 1 && typeof value.__specialNumber__ === 'string') {
            if (value.__specialNumber__ === 'NaN') return NaN;
            if (value.__specialNumber__ === 'Infinity') return Infinity;
            if (value.__specialNumber__ === '-Infinity') return -Infinity;
        }
        if (Object.keys(value).length === 1 && typeof value.__fn__ === 'string') {
            let fn = (new Function('"use strict"; return (' + value.__fn__ + ');'))();
            if (typeof fn !== 'function') throw new Error('Invalid function in transported config.');
            return fn;
        }
        let out = {};
        for (let k in value) out[k] = decodeFunctionsFromTransport(value[k]);
        return out;
    }
    return value;
}

function makeEditorCardTypesTable() {
    let out = cloneJsValue(BASE_CARD_TYPES);
    for (let key in out) {
        let def = out[key];
        if (!def || typeof def !== 'object') continue;
        // Keep runtime fields intact; mirror price into energyCost for editor compatibility.
        if (Number.isFinite(def.price) && !Number.isFinite(def.energyCost)) {
            def.energyCost = def.price;
        }
    }
    return out;
}

function makeRuntimeCardTypesTableFromEditor(rawTable) {
    let out = cloneJsValue(rawTable || {});
    for (let key in out) {
        let def = out[key];
        if (!def || typeof def !== 'object') continue;
        // Accept editor alias while preserving runtime fields.
        if (Number.isFinite(def.energyCost)) def.price = def.energyCost;
    }
    return out;
}

function makeEditorUnitStatsTable() {
    let out = cloneJsValue(BASE_UNIT_STATS);
    for (let key in out) {
        let def = out[key];
        if (!def || typeof def !== 'object') continue;
        // Keep runtime fields intact; mirror price into energyCost for editor compatibility.
        if (Number.isFinite(def.price) && !Number.isFinite(def.energyCost)) {
            def.energyCost = def.price;
        }
    }
    return out;
}

function makeRuntimeUnitStatsTableFromEditor(rawTable) {
    let out = cloneJsValue(rawTable || {});
    for (let key in out) {
        let def = out[key];
        if (!def || typeof def !== 'object') continue;
        // Accept editor alias while preserving runtime fields.
        if (Number.isFinite(def.energyCost)) def.price = def.energyCost;
    }
    return out;
}

function createEditableRuntimeConfigSnapshot() {
    return {
        version: 1,
        config: {
            MINIMAP_SIZE,
            TILE,
            GRID_W,
            GRID_H,
            GOLD_MINE_COUNT,
            GOLD_MINE_MIN,
            GOLD_MINE_MAX,
            GOLD_MINE_AREA,
            ASTAR_MINE_COUNT,
            ASTAR_MINE_MIN,
            ASTAR_MINE_MAX,
            STARTING_MONEY,
            STARTING_ASTAR,
            MAP_TYPE,
            TYPE_FLOOR,
            TYPE_WALL,
            CONFIG_MAX_POP,
            TICK_RATE,
            LOCKSTEP_PIPELINE_MIN,
            UNIT_EFFECTIVE_STATS_RECALC_TICKS,
            UNIT_COLLISION_RECALC_TICKS,
            ASTAR_MAX_ITERS_LIMIT,
            ASTAR_ITER_BUDGET_PER_PLAYER_TICK,
            WORKER_AI_TICK_DELAY,
        },
        progression: {
            RESEARCH_COST_EXP,
            RESEARCH_WORK_EXP,
            RESEARCH_WORK_BASE,
            RESEARCH_BONUS_EXP_UNITS,
            RESEARCH_BONUS_EXP_OTHER,
            RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP,
            MAX_THING_LEVEL,
            MAX_RESEARCH_LEVEL,
            BUILDING_ENERGY_LEVEL_EXP: BUILDING_ENERGY_LEVEL_EXP,
            BUILDING_LEVEL_MULT_EXP,
            BUILDING_DAMAGE_LEVEL_EXP,
            BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL,
            BUILDING_LINEAR_VISION_BONUS_PER_LEVEL,
            SAND_GUN_CD_LEVEL_EXP,
            RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP,
            RESEARCH_BUILDING_EFFICIENCY_CAP,
            UNIT_COLLECTOR_GATHER_LEVEL_EXP,
            UNIT_WORKER_SPECIALIST_BASE_RATE,
            UNIT_WORKER_SPECIALIST_LEVEL_EXP,
        },
        tables: {
            BASE_CARD_TYPES: makeEditorCardTypesTable(),
            BASE_CARD_DEFAULT_ENERGY: cloneJsValue(BASE_CARD_DEFAULT_ENERGY),
            DESCRIPTIONS: cloneJsValue(DESCRIPTIONS),
            BUILD_CATEGORIES: cloneJsValue(BUILD_CATEGORIES),
            BARRACK_SPAWN_CONFIG: cloneJsValue(BARRACK_SPAWN_CONFIG),
            BASE_UNIT_STATS: makeEditorUnitStatsTable(),
            UNIT_LEVEL_SCALING: cloneJsValue(UNIT_LEVEL_SCALING),
            BUILDING_FORMULA_CONFIG: cloneJsValue(BUILDING_FORMULA_CONFIG),
            UNIT_FORMULA_CONFIG: cloneJsValue(UNIT_FORMULA_CONFIG),
            RESEARCH_FORMULA_CONFIG: cloneJsValue(RESEARCH_FORMULA_CONFIG),
            PRECOMPUTED_SOFT_CAP_MAP: cloneJsValue(PRECOMPUTED_SOFT_CAP_MAP),
            RESEARCH_STAT_LABELS: cloneJsValue(RESEARCH_STAT_LABELS),
            RESEARCHABLE_UNIT_STATS: cloneJsValue(RESEARCHABLE_UNIT_STATS),
            PRECOMPUTED_UNIT_STAT_KEYS: cloneJsValue(PRECOMPUTED_UNIT_STAT_KEYS),
            PRECOMPUTED_BUILDING_STAT_KEYS: cloneJsValue(PRECOMPUTED_BUILDING_STAT_KEYS),
            RESEARCH_DECREASE_STATS: cloneJsValue(RESEARCH_DECREASE_STATS),
        }
    };
}

function serializeEditableRuntimeConfigForTransport() {
    return encodeFunctionsForTransport(createEditableRuntimeConfigSnapshot());
}

function ensureDefaultEditableRuntimeConfigSnapshot() {
    if (defaultEditableRuntimeConfigSnapshot) return;
    defaultEditableRuntimeConfigSnapshot = cloneJsValue(createEditableRuntimeConfigSnapshot());
}

function syncMainMenuFromRuntimeConfig() {
    let setValue = (id, value) => {
        let el = document.getElementById(id);
        if (!el) return;
        el.value = String(value);
    };

    setValue('cfg-mapsize', GRID_W);
    setValue('cfg-gold-count', GOLD_MINE_COUNT);
    setValue('cfg-gold-min', GOLD_MINE_MIN);
    setValue('cfg-gold-max', GOLD_MINE_MAX);
    setValue('cfg-astar-mine-count', ASTAR_MINE_COUNT);
    setValue('cfg-astar-mine-min', ASTAR_MINE_MIN);
    setValue('cfg-astar-mine-max', ASTAR_MINE_MAX);
    setValue('cfg-max-pop', CONFIG_MAX_POP);
    setValue('cfg-starting-energy', STARTING_MONEY);
    setValue('cfg-starting-astar', STARTING_ASTAR);
    setValue('cfg-map-type', MAP_TYPE);
    setValue('cfg-tick-rate', TICK_RATE);
    setValue('cfg-pipeline-delay', LOCKSTEP_PIPELINE_MIN);
    setValue('cfg-unit-eff-stats-ticks', UNIT_EFFECTIVE_STATS_RECALC_TICKS);
    setValue('cfg-unit-collision-ticks', UNIT_COLLISION_RECALC_TICKS);
    setValue('cfg-astar-iter-budget-per-player', ASTAR_ITER_BUDGET_PER_PLAYER_TICK);
    setValue('cfg-worker-ai-tick-delay', WORKER_AI_TICK_DELAY);
    setValue('cfg-max-thing-level', MAX_THING_LEVEL);
    setValue('cfg-max-research-level', MAX_RESEARCH_LEVEL);
}

function applyEditableRuntimeConfigObject(rawConfig, options = null) {
    let opts = options && typeof options === 'object' ? options : {};
    let cfgObject = rawConfig;
    if (opts.fromTransport) cfgObject = decodeFunctionsFromTransport(cfgObject);

    if (!cfgObject || typeof cfgObject !== 'object' || Array.isArray(cfgObject)) {
        throw new Error('Runtime config must be an object.');
    }

    let cfg = (cfgObject.config && typeof cfgObject.config === 'object') ? cfgObject.config : {};
    let prog = (cfgObject.progression && typeof cfgObject.progression === 'object') ? cfgObject.progression : {};
    let tables = (cfgObject.tables && typeof cfgObject.tables === 'object') ? cfgObject.tables : {};

    if (Number.isFinite(Number(cfg.MINIMAP_SIZE))) MINIMAP_SIZE = Math.max(32, Math.floor(Number(cfg.MINIMAP_SIZE)));
    if (Number.isFinite(Number(cfg.TILE))) TILE = Math.max(8, Math.floor(Number(cfg.TILE)));
    if (Number.isFinite(Number(cfg.TYPE_FLOOR))) TYPE_FLOOR = Math.floor(Number(cfg.TYPE_FLOOR));
    if (Number.isFinite(Number(cfg.TYPE_WALL))) TYPE_WALL = Math.floor(Number(cfg.TYPE_WALL));

    let nextGridW = Number(cfg.GRID_W);
    let nextGridH = Number(cfg.GRID_H);
    if (Number.isFinite(nextGridW)) GRID_W = Math.max(8, Math.floor(nextGridW));
    if (Number.isFinite(nextGridH)) GRID_H = Math.max(8, Math.floor(nextGridH));
    else GRID_H = GRID_W;
    WORLD_W = GRID_W * TILE;
    WORLD_H = GRID_H * TILE;

    if (Number.isFinite(Number(cfg.GOLD_MINE_COUNT))) GOLD_MINE_COUNT = Math.max(0, Math.floor(Number(cfg.GOLD_MINE_COUNT)));
    if (Number.isFinite(Number(cfg.GOLD_MINE_MIN))) GOLD_MINE_MIN = Math.max(0, Math.floor(Number(cfg.GOLD_MINE_MIN)));
    if (Number.isFinite(Number(cfg.GOLD_MINE_MAX))) GOLD_MINE_MAX = Math.max(0, Math.floor(Number(cfg.GOLD_MINE_MAX)));
    if (Number.isFinite(Number(cfg.GOLD_MINE_AREA))) GOLD_MINE_AREA = Math.max(1, Math.floor(Number(cfg.GOLD_MINE_AREA)));
    if (Number.isFinite(Number(cfg.ASTAR_MINE_COUNT))) ASTAR_MINE_COUNT = Math.max(0, Math.floor(Number(cfg.ASTAR_MINE_COUNT)));
    if (Number.isFinite(Number(cfg.ASTAR_MINE_MIN))) ASTAR_MINE_MIN = Math.max(0, Math.floor(Number(cfg.ASTAR_MINE_MIN)));
    if (Number.isFinite(Number(cfg.ASTAR_MINE_MAX))) ASTAR_MINE_MAX = Math.max(0, Math.floor(Number(cfg.ASTAR_MINE_MAX)));
    if (Number.isFinite(Number(cfg.STARTING_MONEY))) STARTING_MONEY = Math.max(0, Math.floor(Number(cfg.STARTING_MONEY)));
    if (Number.isFinite(Number(cfg.STARTING_ASTAR))) STARTING_ASTAR = Math.max(0, Number(cfg.STARTING_ASTAR));
    if (typeof cfg.MAP_TYPE === 'string' && cfg.MAP_TYPE.trim()) MAP_TYPE = cfg.MAP_TYPE.trim();
    if (Number.isFinite(Number(cfg.CONFIG_MAX_POP))) CONFIG_MAX_POP = Math.max(1, Math.floor(Number(cfg.CONFIG_MAX_POP)));

    let nextTickRate = Number(cfg.TICK_RATE);
    let nextPipelineDelay = Number(cfg.LOCKSTEP_PIPELINE_MIN);
    applyTimingConfig(nextTickRate, nextPipelineDelay);
    if (Number.isFinite(Number(cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS))) {
        UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS))));
    }
    if (Number.isFinite(Number(cfg.UNIT_COLLISION_RECALC_TICKS))) {
        UNIT_COLLISION_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(cfg.UNIT_COLLISION_RECALC_TICKS))));
    }
    if (Number.isFinite(Number(cfg.ASTAR_MAX_ITERS_LIMIT))) {
        ASTAR_MAX_ITERS_LIMIT = Math.max(256, Math.min(18000, Math.floor(Number(cfg.ASTAR_MAX_ITERS_LIMIT))));
    }
    if (Number.isFinite(Number(cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK))) {
        ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(Number(cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK))));
    }
    let workerAiTickDelay = Number(cfg.WORKER_AI_TICK_DELAY);
    if (!Number.isFinite(workerAiTickDelay)) workerAiTickDelay = Number(cfg.WORKER_HEAVY_AI_STRIDE);
    if (Number.isFinite(workerAiTickDelay)) {
        WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(workerAiTickDelay)));
    }

    if (Number.isFinite(Number(prog.RESEARCH_COST_EXP))) RESEARCH_COST_EXP = Math.max(1, Number(prog.RESEARCH_COST_EXP));
    if (Number.isFinite(Number(prog.RESEARCH_WORK_EXP))) RESEARCH_WORK_EXP = Math.max(1, Number(prog.RESEARCH_WORK_EXP));
    if (Number.isFinite(Number(prog.RESEARCH_WORK_BASE))) RESEARCH_WORK_BASE = Math.max(1, Math.floor(Number(prog.RESEARCH_WORK_BASE)));
    if (Number.isFinite(Number(prog.RESEARCH_BONUS_EXP_UNITS))) RESEARCH_BONUS_EXP_UNITS = Math.max(1, Number(prog.RESEARCH_BONUS_EXP_UNITS));
    if (Number.isFinite(Number(prog.RESEARCH_BONUS_EXP_OTHER))) RESEARCH_BONUS_EXP_OTHER = Math.max(1, Number(prog.RESEARCH_BONUS_EXP_OTHER));
    if (Number.isFinite(Number(prog.RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP))) RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP = Math.max(1, Number(prog.RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP));
    if (Number.isFinite(Number(prog.MAX_THING_LEVEL))) MAX_THING_LEVEL = Math.max(1, Math.floor(Number(prog.MAX_THING_LEVEL)));
    if (Number.isFinite(Number(prog.MAX_RESEARCH_LEVEL))) MAX_RESEARCH_LEVEL = Math.max(1, Math.floor(Number(prog.MAX_RESEARCH_LEVEL)));
    if (Number.isFinite(Number(prog.BUILDING_ENERGY_LEVEL_EXP))) BUILDING_ENERGY_LEVEL_EXP = Math.max(1, Number(prog.BUILDING_ENERGY_LEVEL_EXP));
    if (Number.isFinite(Number(prog.BUILDING_ENERGY_LEVEL_EXP))) BUILDING_ENERGY_LEVEL_EXP = Math.max(1, Number(prog.BUILDING_ENERGY_LEVEL_EXP));
    if (Number.isFinite(Number(prog.BUILDING_LEVEL_MULT_EXP))) BUILDING_LEVEL_MULT_EXP = Math.max(1, Number(prog.BUILDING_LEVEL_MULT_EXP));
    if (Number.isFinite(Number(prog.BUILDING_DAMAGE_LEVEL_EXP))) BUILDING_DAMAGE_LEVEL_EXP = Math.max(1, Number(prog.BUILDING_DAMAGE_LEVEL_EXP));
    if (Number.isFinite(Number(prog.BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL))) BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL = Math.max(0, Math.min(0.95, Number(prog.BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL)));
    if (Number.isFinite(Number(prog.BUILDING_LINEAR_VISION_BONUS_PER_LEVEL))) BUILDING_LINEAR_VISION_BONUS_PER_LEVEL = Math.max(0, Number(prog.BUILDING_LINEAR_VISION_BONUS_PER_LEVEL));
    if (Number.isFinite(Number(prog.SAND_GUN_CD_LEVEL_EXP))) SAND_GUN_CD_LEVEL_EXP = Math.max(0.01, Number(prog.SAND_GUN_CD_LEVEL_EXP));
    if (Number.isFinite(Number(prog.RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP))) RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP = Math.max(1, Number(prog.RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP));
    if (Number.isFinite(Number(prog.RESEARCH_BUILDING_EFFICIENCY_CAP))) RESEARCH_BUILDING_EFFICIENCY_CAP = Math.max(0, Number(prog.RESEARCH_BUILDING_EFFICIENCY_CAP));
    if (Number.isFinite(Number(prog.UNIT_COLLECTOR_GATHER_LEVEL_EXP))) UNIT_COLLECTOR_GATHER_LEVEL_EXP = Math.max(0, Number(prog.UNIT_COLLECTOR_GATHER_LEVEL_EXP));
    if (Number.isFinite(Number(prog.UNIT_WORKER_SPECIALIST_BASE_RATE))) UNIT_WORKER_SPECIALIST_BASE_RATE = Math.max(0, Number(prog.UNIT_WORKER_SPECIALIST_BASE_RATE));
    if (Number.isFinite(Number(prog.UNIT_WORKER_SPECIALIST_LEVEL_EXP))) UNIT_WORKER_SPECIALIST_LEVEL_EXP = Math.max(1, Number(prog.UNIT_WORKER_SPECIALIST_LEVEL_EXP));

    BUILDING_FORMULA_CONFIG.energyLevelExp = BUILDING_ENERGY_LEVEL_EXP;
    BUILDING_FORMULA_CONFIG.levelMultExp = BUILDING_LEVEL_MULT_EXP;
    BUILDING_FORMULA_CONFIG.damageLevelExp = BUILDING_DAMAGE_LEVEL_EXP;
    BUILDING_FORMULA_CONFIG.linearCdReductionPerLevel = BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL;
    BUILDING_FORMULA_CONFIG.linearVisionBonusPerLevel = BUILDING_LINEAR_VISION_BONUS_PER_LEVEL;
    BUILDING_FORMULA_CONFIG.sandGunCdLevelExp = SAND_GUN_CD_LEVEL_EXP;
    BUILDING_FORMULA_CONFIG.researchEfficiencyLevelExp = RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP;
    BUILDING_FORMULA_CONFIG.researchEfficiencyCap = RESEARCH_BUILDING_EFFICIENCY_CAP;
    UNIT_FORMULA_CONFIG.collectorGatherLevelExp = UNIT_COLLECTOR_GATHER_LEVEL_EXP;
    UNIT_FORMULA_CONFIG.workerSpecialistBaseRate = UNIT_WORKER_SPECIALIST_BASE_RATE;
    UNIT_FORMULA_CONFIG.workerSpecialistLevelExp = UNIT_WORKER_SPECIALIST_LEVEL_EXP;

    if (tables.BASE_CARD_TYPES) replaceObjectContents(BASE_CARD_TYPES, makeRuntimeCardTypesTableFromEditor(tables.BASE_CARD_TYPES));
    if (tables.BASE_CARD_DEFAULT_ENERGY) replaceObjectContents(BASE_CARD_DEFAULT_ENERGY, tables.BASE_CARD_DEFAULT_ENERGY);
    if (tables.BASE_CARD_DEFAULT_ENERGY) replaceObjectContents(BASE_CARD_DEFAULT_ENERGY, tables.BASE_CARD_DEFAULT_ENERGY);
    if (tables.DESCRIPTIONS) replaceObjectContents(DESCRIPTIONS, tables.DESCRIPTIONS);
    if (tables.BUILD_CATEGORIES) replaceObjectContents(BUILD_CATEGORIES, tables.BUILD_CATEGORIES);
    if (tables.BARRACK_SPAWN_CONFIG) replaceObjectContents(BARRACK_SPAWN_CONFIG, tables.BARRACK_SPAWN_CONFIG);
    if (tables.BASE_UNIT_STATS) replaceObjectContents(BASE_UNIT_STATS, makeRuntimeUnitStatsTableFromEditor(tables.BASE_UNIT_STATS));
    if (tables.UNIT_LEVEL_SCALING) replaceObjectContents(UNIT_LEVEL_SCALING, tables.UNIT_LEVEL_SCALING);
    if (tables.BUILDING_FORMULA_CONFIG) replaceObjectContents(BUILDING_FORMULA_CONFIG, tables.BUILDING_FORMULA_CONFIG);
    if (tables.UNIT_FORMULA_CONFIG) replaceObjectContents(UNIT_FORMULA_CONFIG, tables.UNIT_FORMULA_CONFIG);
    if (tables.RESEARCH_FORMULA_CONFIG) replaceObjectContents(RESEARCH_FORMULA_CONFIG, tables.RESEARCH_FORMULA_CONFIG);
    if (tables.PRECOMPUTED_SOFT_CAP_MAP) replaceObjectContents(PRECOMPUTED_SOFT_CAP_MAP, tables.PRECOMPUTED_SOFT_CAP_MAP);
    if (tables.RESEARCH_STAT_LABELS) replaceObjectContents(RESEARCH_STAT_LABELS, tables.RESEARCH_STAT_LABELS);
    if (tables.RESEARCHABLE_UNIT_STATS) replaceObjectContents(RESEARCHABLE_UNIT_STATS, tables.RESEARCHABLE_UNIT_STATS);
    if (tables.RESEARCH_DECREASE_STATS) replaceObjectContents(RESEARCH_DECREASE_STATS, tables.RESEARCH_DECREASE_STATS);
    if (tables.PRECOMPUTED_UNIT_STAT_KEYS) replaceArrayContents(PRECOMPUTED_UNIT_STAT_KEYS, tables.PRECOMPUTED_UNIT_STAT_KEYS);
    if (tables.PRECOMPUTED_BUILDING_STAT_KEYS) replaceArrayContents(PRECOMPUTED_BUILDING_STAT_KEYS, tables.PRECOMPUTED_BUILDING_STAT_KEYS);

    BUILDING_ENERGY_LEVEL_EXP = Math.max(1, Number(BUILDING_FORMULA_CONFIG.energyLevelExp ?? BUILDING_FORMULA_CONFIG.energyLevelExp) || 1);
    BUILDING_LEVEL_MULT_EXP = Math.max(1, Number(BUILDING_FORMULA_CONFIG.levelMultExp) || 1);
    BUILDING_DAMAGE_LEVEL_EXP = Math.max(1, Number(BUILDING_FORMULA_CONFIG.damageLevelExp) || 1);
    BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL = Math.max(0, Math.min(0.95, Number(BUILDING_FORMULA_CONFIG.linearCdReductionPerLevel) || 0));
    BUILDING_LINEAR_VISION_BONUS_PER_LEVEL = Math.max(0, Number(BUILDING_FORMULA_CONFIG.linearVisionBonusPerLevel) || 0);
    SAND_GUN_CD_LEVEL_EXP = Math.max(0.01, Number(BUILDING_FORMULA_CONFIG.sandGunCdLevelExp) || 0.01);
    RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP = Math.max(1, Number(BUILDING_FORMULA_CONFIG.researchEfficiencyLevelExp) || 1);
    RESEARCH_BUILDING_EFFICIENCY_CAP = Math.max(0, Number(BUILDING_FORMULA_CONFIG.researchEfficiencyCap) || 0);
    UNIT_COLLECTOR_GATHER_LEVEL_EXP = Math.max(0, Number(UNIT_FORMULA_CONFIG.collectorGatherLevelExp) || 0);
    UNIT_WORKER_SPECIALIST_BASE_RATE = Math.max(0, Number(UNIT_FORMULA_CONFIG.workerSpecialistBaseRate) || 0);
    UNIT_WORKER_SPECIALIST_LEVEL_EXP = Math.max(1, Number(UNIT_FORMULA_CONFIG.workerSpecialistLevelExp) || 1);

    normalizeBaseCardDefinitions();
    PRECOMPUTED_STATS_READY = false;
    if (!opts.deferPrecompute) rebuildPrecomputedStatsMap();
    startingResourcesConfig = normalizeStartingResourcesConfig(startingResourcesConfig);
    syncMainMenuFromRuntimeConfig();
}

function makeConfigEditorTextFromCurrentConfig() {
    return stringifyJsLike(createEditableRuntimeConfigSnapshot());
}

function setConfigPopupOpen(open) {
    let popup = document.getElementById('config-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    if (open) {
        ensureDefaultEditableRuntimeConfigSnapshot();
        let ta = document.getElementById('config-editor-text');
        if (ta) ta.value = makeConfigEditorTextFromCurrentConfig();
    }
    return wasOpen !== open;
}

function setOptimizationPopupOpen(open) {
    let popup = document.getElementById('optimization-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    popup.classList.toggle('hidden', !open);
    return wasOpen !== open;
}

function applyConfigEditorChanges() {
    let ta = document.getElementById('config-editor-text');
    if (!ta) return;
    try {
        let parsed = parseConfigEditorObject(ta.value);
        applyEditableRuntimeConfigObject(parsed);
        ta.value = makeConfigEditorTextFromCurrentConfig();
        showUiBanner('Runtime config applied.', 'success');
    } catch (err) {
        showUiBanner(`Config parse/apply error: ${err && err.message ? err.message : 'Unknown error'}`, 'error', 3600);
    }
}

function resetConfigEditorToDefaults() {
    ensureDefaultEditableRuntimeConfigSnapshot();
    if (!confirm('Reset runtime config to startup defaults?')) return;
    applyEditableRuntimeConfigObject(cloneJsValue(defaultEditableRuntimeConfigSnapshot));
    let ta = document.getElementById('config-editor-text');
    if (ta) ta.value = makeConfigEditorTextFromCurrentConfig();
}

function createEditableRuntimeConfigSnapshotFromMainMenu() {
    let snapshot = createEditableRuntimeConfigSnapshot();
    let cfg = snapshot.config;
    let getNumber = (id, fallback) => {
        let el = document.getElementById(id);
        if (!el) return fallback;
        let value = Number(el.value);
        return Number.isFinite(value) ? value : fallback;
    };
    let getString = (id, fallback) => {
        let el = document.getElementById(id);
        if (!el) return fallback;
        let value = String(el.value || '').trim();
        return value || fallback;
    };

    cfg.GRID_W = Math.max(8, Math.floor(getNumber('cfg-mapsize', cfg.GRID_W)));
    cfg.GRID_H = cfg.GRID_W;
    cfg.GOLD_MINE_COUNT = Math.max(0, Math.floor(getNumber('cfg-gold-count', cfg.GOLD_MINE_COUNT)));
    cfg.GOLD_MINE_MIN = Math.max(0, Math.floor(getNumber('cfg-gold-min', cfg.GOLD_MINE_MIN)));
    cfg.GOLD_MINE_MAX = Math.max(0, Math.floor(getNumber('cfg-gold-max', cfg.GOLD_MINE_MAX)));
    cfg.ASTAR_MINE_COUNT = Math.max(0, Math.floor(getNumber('cfg-astar-mine-count', cfg.ASTAR_MINE_COUNT)));
    cfg.ASTAR_MINE_MIN = Math.max(0, Math.floor(getNumber('cfg-astar-mine-min', cfg.ASTAR_MINE_MIN)));
    cfg.ASTAR_MINE_MAX = Math.max(0, Math.floor(getNumber('cfg-astar-mine-max', cfg.ASTAR_MINE_MAX)));
    cfg.STARTING_MONEY = Math.max(0, Math.floor(getNumber('cfg-starting-energy', cfg.STARTING_MONEY)));
    cfg.STARTING_ASTAR = Math.max(0, getNumber('cfg-starting-astar', cfg.STARTING_ASTAR));
    cfg.MAP_TYPE = getString('cfg-map-type', cfg.MAP_TYPE);
    cfg.CONFIG_MAX_POP = Math.max(1, Math.floor(getNumber('cfg-max-pop', cfg.CONFIG_MAX_POP)));
    cfg.TICK_RATE = Math.max(5, Math.floor(getNumber('cfg-tick-rate', cfg.TICK_RATE)));
    cfg.LOCKSTEP_PIPELINE_MIN = Math.max(0, Math.floor(getNumber('cfg-pipeline-delay', cfg.LOCKSTEP_PIPELINE_MIN)));
    cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(getNumber('cfg-unit-eff-stats-ticks', cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS))));
    cfg.UNIT_COLLISION_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(getNumber('cfg-unit-collision-ticks', cfg.UNIT_COLLISION_RECALC_TICKS))));
    cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(getNumber('cfg-astar-iter-budget-per-player', cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK))));
    cfg.WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(getNumber('cfg-worker-ai-tick-delay', cfg.WORKER_AI_TICK_DELAY))));

    snapshot.progression.MAX_THING_LEVEL = Math.max(1, Math.floor(getNumber('cfg-max-thing-level', snapshot.progression.MAX_THING_LEVEL)));
    snapshot.progression.MAX_RESEARCH_LEVEL = Math.max(1, Math.floor(getNumber('cfg-max-research-level', snapshot.progression.MAX_RESEARCH_LEVEL)));

    return snapshot;
}

function applyMainMenuControlsToRuntimeState() {
    let snapshot = createEditableRuntimeConfigSnapshotFromMainMenu();
    let cfg = snapshot.config;
    let prog = snapshot.progression;

    GRID_W = cfg.GRID_W;
    GRID_H = cfg.GRID_H;
    WORLD_W = GRID_W * TILE;
    WORLD_H = GRID_H * TILE;
    GOLD_MINE_COUNT = cfg.GOLD_MINE_COUNT;
    GOLD_MINE_MIN = cfg.GOLD_MINE_MIN;
    GOLD_MINE_MAX = cfg.GOLD_MINE_MAX;
    ASTAR_MINE_COUNT = cfg.ASTAR_MINE_COUNT;
    ASTAR_MINE_MIN = cfg.ASTAR_MINE_MIN;
    ASTAR_MINE_MAX = cfg.ASTAR_MINE_MAX;
    STARTING_MONEY = cfg.STARTING_MONEY;
    STARTING_ASTAR = cfg.STARTING_ASTAR;
    MAP_TYPE = cfg.MAP_TYPE;
    CONFIG_MAX_POP = cfg.CONFIG_MAX_POP;
    MAX_THING_LEVEL = prog.MAX_THING_LEVEL;
    MAX_RESEARCH_LEVEL = prog.MAX_RESEARCH_LEVEL;
    UNIT_EFFECTIVE_STATS_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(cfg.UNIT_EFFECTIVE_STATS_RECALC_TICKS) || UNIT_EFFECTIVE_STATS_RECALC_TICKS)));
    UNIT_COLLISION_RECALC_TICKS = Math.max(1, Math.min(240, Math.floor(Number(cfg.UNIT_COLLISION_RECALC_TICKS) || UNIT_COLLISION_RECALC_TICKS)));
    ASTAR_ITER_BUDGET_PER_PLAYER_TICK = Math.max(256, Math.min(500000, Math.floor(Number(cfg.ASTAR_ITER_BUDGET_PER_PLAYER_TICK) || ASTAR_ITER_BUDGET_PER_PLAYER_TICK)));
    WORKER_AI_TICK_DELAY = Math.max(1, Math.min(60, Math.floor(Number(cfg.WORKER_AI_TICK_DELAY) || WORKER_AI_TICK_DELAY)));
    applyTimingConfig(cfg.TICK_RATE, cfg.LOCKSTEP_PIPELINE_MIN);

    let gameModeEl = document.getElementById('cfg-gamemode');
    if (gameModeEl) gameMode = String(gameModeEl.value || gameMode || 'destroy');
    let fullVisEl = document.getElementById('cfg-full-vis');
    if (fullVisEl) fullVisibility = !!fullVisEl.checked;
}

function createMainMenuSettingsSnapshot() {
    let numberIds = [
        'cfg-tick-rate', 'cfg-pipeline-delay', 'cfg-mapsize', 'cfg-max-pop', 'cfg-starting-energy', 'cfg-starting-astar',
        'cfg-max-thing-level', 'cfg-gold-count', 'cfg-gold-min', 'cfg-gold-max', 'cfg-astar-mine-count', 'cfg-astar-mine-min', 'cfg-astar-mine-max',
        'cfg-max-research-level', 'cfg-unit-eff-stats-ticks', 'cfg-unit-collision-ticks', 'cfg-astar-iter-budget-per-player', 'cfg-worker-ai-tick-delay'
    ];
    let selectIds = ['cfg-gamemode', 'cfg-map-type'];
    let checkboxIds = ['cfg-full-vis'];

    let out = {
        version: 2,
        createdAt: Date.now(),
        lobby: {
            numbers: {},
            selects: {},
            checks: {}
        },
        startingResources: cloneStartingResourcesConfig(),
        editableConfig: encodeFunctionsForTransport(createEditableRuntimeConfigSnapshotFromMainMenu())
    };

    for (let id of numberIds) {
        let el = document.getElementById(id);
        if (el) out.lobby.numbers[id] = Number(el.value);
    }
    for (let id of selectIds) {
        let el = document.getElementById(id);
        if (el) out.lobby.selects[id] = String(el.value);
    }
    for (let id of checkboxIds) {
        let el = document.getElementById(id);
        if (el) out.lobby.checks[id] = !!el.checked;
    }

    return out;
}

function applyMainMenuSettingsSnapshot(rawData) {
    let data = (rawData && typeof rawData === 'object') ? rawData : {};
    let lobby = (data.lobby && typeof data.lobby === 'object') ? data.lobby : {};
    let numbers = (lobby.numbers && typeof lobby.numbers === 'object') ? lobby.numbers : {};
    let selects = (lobby.selects && typeof lobby.selects === 'object') ? lobby.selects : {};
    let checks = (lobby.checks && typeof lobby.checks === 'object') ? lobby.checks : {};

    for (let id in numbers) {
        let el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'number') el.value = String(numbers[id]);
    }
    for (let id in selects) {
        let el = document.getElementById(id);
        if (!el) continue;
        el.value = String(selects[id]);
    }
    for (let id in checks) {
        let el = document.getElementById(id);
        if (!el) continue;
        el.checked = !!checks[id];
    }

    let importedMaxThingLevel = Math.max(1, Math.floor(Number((document.getElementById('cfg-max-thing-level') || {}).value) || MAX_THING_LEVEL));
    let importedMaxResearchLevel = Math.max(1, Math.floor(Number((document.getElementById('cfg-max-research-level') || {}).value) || MAX_RESEARCH_LEVEL));
    MAX_THING_LEVEL = importedMaxThingLevel;
    MAX_RESEARCH_LEVEL = importedMaxResearchLevel;
    startingResourcesConfig = normalizeStartingResourcesConfig(data.startingResources || makeDefaultStartingResourcesConfig());
    applyMainMenuControlsToRuntimeState();
    let appliedAdvancedConfig = false;
    if (data.editableConfig && typeof data.editableConfig === 'object') {
        try {
            applyEditableRuntimeConfigObject(data.editableConfig, { fromTransport: true });
            appliedAdvancedConfig = true;
        } catch {
            // Keep imported non-advanced settings even if advanced config payload is invalid.
        }
    }
    if (appliedAdvancedConfig) {
        syncMainMenuFromRuntimeConfig();
        let gameModeEl = document.getElementById('cfg-gamemode');
        if (gameModeEl) gameModeEl.value = gameMode;
        let fullVisEl = document.getElementById('cfg-full-vis');
        if (fullVisEl) fullVisEl.checked = fullVisibility;
    }

    let popup = document.getElementById('starting-resources-popup');
    if (popup && !popup.classList.contains('hidden')) renderStartingResourcesPopupContent();
}

function downloadMainMenuSettings() {
    let data = createMainMenuSettingsSnapshot();
    let blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    let url = URL.createObjectURL(blob);
    let a = document.createElement('a');
    let stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `defence3-settings-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importMainMenuSettingsFromFile(file) {
    if (!file) return;
    let reader = new FileReader();
    reader.onload = () => {
        try {
            let parsed = JSON.parse(String(reader.result || '{}'));
            applyMainMenuSettingsSnapshot(parsed);
            showUiBanner('Settings imported.', 'success');
        } catch {
            showUiBanner('Invalid settings JSON.', 'error', 3600);
        }
    };
    reader.readAsText(file);
}

function openResearchStatMatrixPopup(kind, key, statKey, fromLevel, toLevel) {
    researchStatMatrixPopupPayload = { kind, key, statKey, fromLevel, toLevel };
    setResearchStatMatrixPopupOpen(true);
}

function bindShopStatsMatrixButtons(container) {
    if (!container) return;
    container.querySelectorAll('.build-stat-matrix-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let matrixId = Number.parseInt(btn.dataset.matrixId || '', 10);
            if (!Number.isFinite(matrixId)) return;
            researchStatMatrixPopupPayload = { shopMatrixId: matrixId };
            setResearchStatMatrixPopupOpen(true);
        });
    });
}

function mulberry32(seed) {
    let s = seed | 0;
    let fn = function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    fn.getState = () => (s | 0);
    fn.setState = (nextState) => { s = (Number(nextState) | 0); };
    return fn;
}

// ============================================================
// CONFIG
// ============================================================
let MINIMAP_SIZE = 160;
let TILE = 32;
let GRID_W = 80, GRID_H = 80;
let WORLD_W = GRID_W * TILE, WORLD_H = GRID_H * TILE;

// Gold mine config (adjustable from menu)
let GOLD_MINE_COUNT = 18;  // total mine tiles distributed across veins
let GOLD_MINE_MIN = 500;
let GOLD_MINE_MAX = 1500;
let GOLD_MINE_AREA = 70;   // area within which mines spawn (centered)
let ASTAR_MINE_COUNT = 12;
let ASTAR_MINE_MIN = 500;
let ASTAR_MINE_MAX = 1500;
let STARTING_MONEY = 2000;
let STARTING_ASTAR = 9000;
let MAP_TYPE = 'random';
let TYPE_FLOOR = 0, TYPE_WALL = 1;
let CONFIG_MAX_POP = 200;
let TICK_RATE = 20; // ticks per second (menu configurable)
let TICK_MS = 1000 / TICK_RATE;
let UNIT_EFFECTIVE_STATS_RECALC_TICKS = 5;
let UNIT_COLLISION_RECALC_TICKS = 5;
let ASTAR_MAX_ITERS_LIMIT = 18000;
let ASTAR_ITER_BUDGET_PER_PLAYER_TICK = 9000;
let WORKER_AI_TICK_DELAY = 3;
let INPUT_DELAY = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 2 : 0; // desktop: immediate lockstep input, touch: small safety buffer
let LOCKSTEP_PIPELINE_MIN = 2;
let LOCKSTEP_PIPELINE_TICKS = Math.max(INPUT_DELAY, LOCKSTEP_PIPELINE_MIN); // keep only a few ticks in flight to avoid strict-lockstep starvation
let LOCKSTEP_PACKET_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
let LOCKSTEP_BUNDLE_RESEND_MS = Math.max(40, Math.floor(TICK_MS * 2));
let LOCKSTEP_RESEND_REQUEST_MS = Math.max(200, Math.floor(TICK_MS * 4));
let LOCKSTEP_HARD_RESYNC_MS = Math.max(3000, Math.floor(TICK_MS * 60));
let LOCKSTEP_STATE_CHECK_INTERVAL = 10;
let LOCKSTEP_DEBUG_HASH_DETAILS = true;
let tickAlpha = 0; // 0..1 interpolation between ticks for smooth rendering

function secondsToTicks(seconds) {
    let sec = Math.max(0, Number(seconds) || 0);
    return Math.max(1, Math.round(sec * TICK_RATE));
}

const C_BG = '#111', C_WALL = '#3a3a3a', C_FLOOR = '#161616';

const PLAYER_COLORS = ['#4488ff', '#ff4444'];
const PLAYER_COLORS_DIM = ['rgba(68,136,255,0.3)', 'rgba(255,68,68,0.3)'];



// ============================================================
// CARD/BUILDING TYPES
// ============================================================
const BASE_CARD_TYPES = {
    // Towers (target: wall)
    pistol: { name: "Pistol", price: 35, icon: "\u26A1", color: "#964B00", visionRange: 3, cd: 2.0, damage: 8, target: 'wall', towerEnergy: 30 },
    smg: { name: "SMG", price: 45, icon: "\u26A1", color: "#aaf", visionRange: 3, cd: 1.25, damage: 5, target: 'wall', towerEnergy: 25 },
    water: { name: "Water", price: 74, icon: "\uD83D\uDCA7", color: "#4af", visionRange: 3, cd: 1.75, damage: 10, wetDuration: 7, target: 'wall', towerEnergy: 95 },
    poison: { name: "Poison", price: 173, icon: "\uD83E\uDDEA", color: "#2d2", visionRange: 3, cd: 2.5, damage: 3, poisonDps: 28, poisonDuration: 5, target: 'wall', towerEnergy: 200 },
    fire: { name: "Fire", price: 375, icon: "\uD83D\uDD25", color: "#f50", visionRange: 3, cd: 5.5, damage: 45, burnDps: 2.25, burnDuration: 3.5, blastDamage: 10, blastRadius: 0.30, target: 'wall', towerEnergy: 350 },
    sand_gun: { name: "Sand Gun", price: 60, icon: "\u231B", color: "#c96", visionRange: 4, cd: 7.5, damage: 5, sandDuration: 9, target: 'wall', towerEnergy: 180 },
    ice: { name: "Ice", price: 700, icon: "\u2744\uFE0F", color: "#afe", visionRange: 3, cd: 2.0, damage: 65, freezeDps: 6.6, freezeDuration: 3.5, target: 'wall', towerEnergy: 400 },
    sniper: { name: "Sniper", price: 1500, icon: "\uD83C\uDFAF", color: "#888", visionRange: 8, cd: 12.0, damage: 170, target: 'wall', towerEnergy: 1500 },
    elements: { name: "Elements", price: 50, icon: "\uD83C\uDF08", color: "#fff", visionRange: 3, cd: 1.75, damage: 1, burnDps: 0.2, poisonDps: 0.2, freezeDps: 0.2, burnDuration: 6, poisonDuration: 6, freezeDuration: 6, wetDuration: 7, sandDuration: 9, target: 'wall', towerEnergy: 150 },
    laser: { name: "Laser", price: 125, icon: "\u26A1", color: "#f00", visionRange: 0, damage: 750, target: 'wall', towerEnergy: 300 },
    watch_tower: { name: "Watch Tower", price: 25, icon: "\uD83D\uDC41\uFE0F", color: "#fd0", visionRange: 10, cd: 1.4, damage: 1, watchDuration: 5, target: 'wall', towerEnergy: 15, isWatchTower: true, maxVisionRange: 24 },

    // Floor items
    sand: { name: "Sand", price: 30, icon: "\u231B", color: "#c96", sandDuration: 0.5, target: 'floor' },
    lava: { name: "Lava", price: 50, icon: "\uD83C\uDF0B", color: "#d22", burnDps: 1, burnDuration: 1.5, target: 'floor' },
    poison_puddle: { name: "Poison Puddle", price: 90, icon: "\u2620\uFE0F", color: "#2d2", poisonDps: 1, poisonDuration: 1.5, target: 'floor' },
    ice_patch: { name: "Ice Patch", price: 60, icon: "\u2744\uFE0F", color: "#afe", freezeDps: 1, freezeDuration: 1.5, target: 'floor' },
    water_puddle: { name: "Water Puddle", price: 50, icon: "\uD83D\uDCA7", color: "#4af", wetDuration: 3, target: 'floor' },
    mine: { name: "Mine", price: 20, icon: "\uD83D\uDCA3", color: "#666", blastDamage: 135, blastRadius: 0.42, target: 'floor' },
    farm: { name: "Energy Farm", price: 40, icon: "\uD83C\uDF3E", color: "#da0", multiplier: 0.02, target: 'floor' },
    astar_farm: { name: "A* Farm", price: 50, icon: "\u2605", color: "#9aa", multiplier: 0.02, target: 'floor' },

    // Special
    spawner: { name: "Collector", price: 150, icon: "\uD83C\uDFED", color: "#432", energy: 60, target: 'floor' },
    astar_spawner: { name: "A*", price: 170, icon: "\u2605", color: "#555", energy: 60, target: 'floor' },
    salvager: { name: "Salvager", price: 150, icon: "\u267B\uFE0F", color: "#543", energy: 60, target: 'floor' },
    builder_spawner: { name: "Builder", price: 180, icon: "\uD83D\uDEA7", color: "#354", energy: 60, target: 'floor' },
    healer_spawner: { name: "Healer", price: 180, icon: "\u25B3\u2695\uFE0F", color: "#355", energy: 60, target: 'floor' },
    research: { name: "Research", price: 260, icon: "\u25B3\uD83E\uDDEA", color: "#446", energy: 70, efficiency: 1, target: 'floor' },
    house: { name: "House", price: 110, icon: "\uD83C\uDFE0", color: "#c95", energy: 30, target: 'floor' },
    area_upgrader: { name: "Area Up", price: 100, icon: "\u2B06\uFE0F", color: "#fd0", target: 'area_upgrade' },

    // Clouds
    cloud_0a: { name: "Cloud R1", price: 100, icon: "\u2601\uFE0F", color: "#f66", target: 'wall', towerEnergy: 200, isCloud: true, pairId: 0 },
    cloud_0b: { name: "Cloud R2", price: 100, icon: "\u2601\uFE0F", color: "#f66", target: 'wall', towerEnergy: 200, isCloud: true, pairId: 0 },
    cloud_1a: { name: "Cloud B1", price: 100, icon: "\u2601\uFE0F", color: "#66f", target: 'wall', towerEnergy: 200, isCloud: true, pairId: 1 },
    cloud_1b: { name: "Cloud B2", price: 100, icon: "\u2601\uFE0F", color: "#66f", target: 'wall', towerEnergy: 200, isCloud: true, pairId: 1 },
    cloud_2a: { name: "Cloud G1", price: 100, icon: "\u2601\uFE0F", color: "#6f6", target: 'wall', towerEnergy: 200, isCloud: true, pairId: 2 },
    cloud_2b: { name: "Cloud G2", price: 100, icon: "\u2601\uFE0F", color: "#6f6", target: 'wall', towerEnergy: 200, isCloud: true, pairId: 2 },
    cloud_3a: { name: "Cloud Y1", price: 100, icon: "\u2601\uFE0F", color: "#ff6", target: 'wall', towerEnergy: 200, isCloud: true, pairId: 3 },
    cloud_3b: { name: "Cloud Y2", price: 100, icon: "\u2601\uFE0F", color: "#ff6", target: 'wall', towerEnergy: 200, isCloud: true, pairId: 3 },

    // Barracks (one per unit type)
    barrack_norm: { name: "Barrack", price: 100, icon: "\u26FA", color: "#686", target: 'floor', unitType: 'norm' },
    barrack_fast: { name: "Fast Brk", price: 80, icon: "\u26FA", color: "#eee", target: 'floor', unitType: 'fast' },
    barrack_tank: { name: "Tank Brk", price: 200, icon: "\u26FA", color: "#555", target: 'floor', unitType: 'tank' },
    barrack_boss: { name: "Boss Brk", price: 500, icon: "\u26FA", color: "#222", target: 'floor', unitType: 'boss' },
    barrack_flying: { name: "Flying Brk", price: 150, icon: "\u26FA", color: "#dd0", target: 'floor', unitType: 'flying' },
    barrack_mole: { name: "Mole Brk", price: 120, icon: "\u26FA", color: "#543", target: 'floor', unitType: 'mole' },
    barrack_poison_resistant: { name: "Psn Res Brk", price: 160, icon: "\u26FA", color: "#2d2", target: 'floor', unitType: 'poison_resistant' },
    barrack_fire_resistant: { name: "Fire Res Brk", price: 160, icon: "\u26FA", color: "#f50", target: 'floor', unitType: 'fire_resistant' },
    barrack_water_resistant: { name: "Wtr Res Brk", price: 160, icon: "\u26FA", color: "#4af", target: 'floor', unitType: 'water_resistant' },
    barrack_ice_resistant: { name: "Ice Res Brk", price: 160, icon: "\u26FA", color: "#afe", target: 'floor', unitType: 'ice_resistant' },
    barrack_laser_resistant: { name: "Lsr Res Brk", price: 160, icon: "\u26FA", color: "#d0f", target: 'floor', unitType: 'laser_resistant' },
    barrack_snake: { name: "Snake Brk", price: 400, icon: "\u26FA", color: "#0f0", target: 'floor', unitType: 'snake' },
    barrack_scout: { name: "Scout Brk", price: 90, icon: "\u26FA", color: "#9cf", target: 'floor', unitType: 'scout' },
};

// Single place for building Energy scaling across all building/card types.
let BUILDING_ENERGY_LEVEL_EXP = 2;
let BUILDING_LEVEL_MULT_EXP = 1.6;
let BUILDING_DAMAGE_LEVEL_EXP = 1.4;
let BUILDING_LINEAR_CD_REDUCTION_PER_LEVEL = 0.10;
let BUILDING_LINEAR_VISION_BONUS_PER_LEVEL = 0.10;
let SAND_GUN_CD_LEVEL_EXP = 0.9;
let RESEARCH_BUILDING_EFFICIENCY_LEVEL_EXP = 1.05;
let RESEARCH_BUILDING_EFFICIENCY_CAP = 3;
let UNIT_COLLECTOR_GATHER_LEVEL_EXP = 1;
let UNIT_WORKER_SPECIALIST_BASE_RATE = 5;
let UNIT_WORKER_SPECIALIST_LEVEL_EXP = 1.22;

const BUILDING_FORMULA_CONFIG = {
    levelMultExp: 1.6,
    energyLevelExp: 2,
    damageLevelExp: 1.4,
    linearCdReductionPerLevel: 0.10,
    linearVisionBonusPerLevel: 0.10,
    sandGunCdLevelExp: 0.9,
    researchEfficiencyLevelExp: 1.05,
    researchEfficiencyCap: 3,
    spawnCdFloor: 0.05,
    spawnedUnitPriceLevelExp: 2,
    farmBaseMultiplierFallback: 1,
    farmLevelPolyCoeff: 1,
    farmLevelPowerExp: 3,
    sandFloorDamageBase: 0.05,
    lavaFloorDamageBase: 1,
    mineFloorDamageBase: 135,
    poisonPuddleFloorDamageBase: 1,
    icePatchFloorDamageBase: 1,
    directTowerCdFloor: 0.25,
    fireBurnDpsMin: 0.1,
    fireBurnDpsFromDamageMul: 0.05,
    fireBurnDurationLevelAdd: 0.5,
    fireBurnDurationFallbackBase: 3,
    fireBurnDurationFallbackLevelAdd: 0.5,
    poisonDpsMin: 0.1,
    poisonDpsFromDamageMul: 0.10,
    poisonDurationLevelAdd: 2.5,
    poisonDurationFallbackBase: 7.5,
    poisonDurationFallbackLevelAdd: 2.5,
    iceFreezeDpsMin: 0.2,
    iceFreezeDpsFromDamageMul: 0.20,
    iceFreezeDurationLevelAdd: 0.5,
    iceFreezeDurationFallbackBase: 3,
    iceFreezeDurationFallbackLevelAdd: 0.5,
    elementsDotMin: 0.1,
    elementsDotFromDamageMul: 0.20,
    elementsDurationLevelAdd: 1,
    elementsDurationFallbackBase: 5,
    lavaBurnDpsMin: 0.1,
    lavaBurnDurationFallback: 1.5,
    poisonPuddleDpsMin: 0.1,
    poisonPuddleDurationFallback: 1.5,
    icePatchDpsMin: 0.2,
    icePatchDurationFallback: 1.5,
    waterWetDurationFallbackBase: 6,
    waterWetDurationFallbackLevelAdd: 1,
    waterPuddleWetDurationFallback: 3,
    waterWetDurationLevelAdd: 1,
    sandGunDurationFallback: 9,
    sandDurationFallback: 0.5,
    watchDurationLevelAdd: 1,
    watchDurationFallbackBase: 4,
};

const UNIT_FORMULA_CONFIG = {
    collectorGatherLevelExp: 1,
    workerSpecialistBaseRate: 5,
    workerSpecialistLevelExp: 1.46,
    workerTransferCooldownLevelExp: 0.9,
    baseAttackCooldownFallback: 1.5,
    baseSpeedFallback: 1,
    baseVisionMin: 0.25,
    baseVisionFallback: 4,
};

const RESEARCH_FORMULA_CONFIG = {
    unitPriceBonusExp: 1.8,
};

// Ensure every card/building type has a canonical base Energy in BASE_CARD_TYPES.
// Keep towerEnergy mirrored for compatibility with existing checks/UI code paths.
const BASE_CARD_DEFAULT_ENERGY = {
    farm: 1000,
    astar_farm: 1000,
    sand: 30,
    lava: 30,
    poison_puddle: 30,
    ice_patch: 30,
    water_puddle: 30,
    mine: 30,
    spawner: 60,
    astar_spawner: 60,
    salvager: 60,
    builder_spawner: 60,
    healer_spawner: 60,
    research: 70,
    house: 120,
    area_upgrader: 1,
};

function normalizeBaseCardDefinitions() {
    for (let cardKey in BASE_CARD_TYPES) {
        let def = BASE_CARD_TYPES[cardKey];
        if (!def || typeof def !== 'object') continue;

        if (!Number.isFinite(def.energy)) {
            if (Number.isFinite(def.towerEnergy)) def.energy = def.towerEnergy;
            else if (Number.isFinite(BASE_CARD_DEFAULT_ENERGY[cardKey])) def.energy = BASE_CARD_DEFAULT_ENERGY[cardKey];
            else if (cardKey.startsWith('barrack_')) def.energy = 100;
            else def.energy = 100;
        }

        if (def.target === 'wall' && !Number.isFinite(def.towerEnergy)) {
            def.towerEnergy = def.energy;
        }
    }
}

normalizeBaseCardDefinitions();

// Descriptions
const DESCRIPTIONS = {
    // Towers
    pistol: "Basic single-shot tower. Reliable damage, decent range.",
    smg: "Rapid-fire tower. Low damage per hit but high fire rate.",
    water: "Soaks enemies, making them vulnerable to freeze DPS.",
    poison: "Applies stacking poison DoT. Low base damage.",
    fire: "Splash damage and burn DoT. Strong vs groups.",
    sand_gun: "Slows enemies drastically. Low damage.",
    ice: "Freezes enemies. Combo with water for freeze DPS.",
    sniper: "Long-range precision tower with very high single-shot damage.",
    elements: "Applies all status effects. Jack of all trades.",
    laser: "Beam between aligned laser towers. Constant very high DPS. Difficult to use effectively.",
    watch_tower: "Marks enemies with Watch and grants shared sight around marked targets. Low Energy, large vision.",
    // Floor
    sand: "Slows enemies walking over it. Fast to build. Strong agains moles. Low health.",
    lava: "Burns enemies walking over it. Fast to build. Strong agains moles. Low health.",
    poison_puddle: "Poisons enemies walking over it. Fast to build. Strong agains moles. Low health.",
    ice_patch: "Freezes enemies walking over it. Fast to build. Strong agains moles. Low health.",
    water_puddle: "Soaks enemies walking over it. Fast to build. Strong agains moles. Low health.",
    mine: "Explodes once when an enemy walks over it. Fast to build. Strong agains moles. Low health.",
    farm: "Energy collectors can harvest here; farm level multiplies energy gather speed.",
    astar_farm: "A* collectors can harvest here; farm level multiplies A* gather speed.",
    // Special
    spawner: "Spawns collectors that gather energy from mines.",
    astar_spawner: "Spawns A*ers that gather A* from gray mines and refill the shared A* stockpile.",
    salvager: "Spawns salvagers that recycle marked buildings.",
    builder_spawner: "Spawns builders that construct buildings. All placed buildings start at 1 energy and need builders to become functional.",
    healer_spawner: "Spawns healers that restore damaged friendly units. Healers fetch supplies from healer spawners before each heal.",
    research: "Runs queued research projects and spawns researchers that complete research tasks.",
    house: "Raises max population by 1.6^{level} while operational.",
    cloud_0a: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_0b: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_1a: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_1b: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_2a: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_2b: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_3a: "Cloud bridge endpoint. Connects areas for adjacency.",
    cloud_3b: "Cloud bridge endpoint. Connects areas for adjacency.",
    area_upgrader: "Upgrade a fully-filled area's multiplier level. Exponential cost.",
    // Barracks
    barrack_norm: "Trains basic infantry. Balanced stats.",
    barrack_fast: "Trains fast scouts. Fragile but quick.",
    barrack_tank: "Trains heavy units. Slow but tough.",
    barrack_boss: "Trains super-heavy units. Expensive powerhouse.",
    barrack_flying: "Trains flying units. Ignores walls, ranged attack.",
    barrack_mole: "Trains moles. Immune to towers, very fragile.",
    barrack_poison_resistant: "Trains poison-immune units.",
    barrack_fire_resistant: "Trains fire-immune units.",
    barrack_water_resistant: "Trains water-immune units.",
    barrack_ice_resistant: "Trains ice-immune units.",
    barrack_laser_resistant: "Trains laser-immune units.",
    barrack_snake: "Trains snakes. Massive Energy, leaves a trail.",
    barrack_scout: "Trains scouts. Fast flying recon units that roam the map.",
    // Units
    norm: "Basic infantry. Balanced stats, cheap to produce.",
    fast: "Fast scout. Low Energy but high speed.",
    tank: "Heavy infantry. High Energy and damage, slow.",
    boss: "Super-heavy unit. Extremely tough and powerful.",
    flying: "Air unit. Ignores walls, has ranged attack.",
    mole: "Stealth unit. Immune to tower fire, very fragile.",
    poison_resistant: "Poison-immune. Attacks with toxic clouds.",
    fire_resistant: "Fire-immune. Attacks with flame bursts.",
    water_resistant: "Water-immune. Attacks with water jets.",
    ice_resistant: "Ice-immune. Attacks with frost shards.",
    laser_resistant: "Laser-immune. Shoots laser beams from range.",
    snake: "Massive serpent. Rams targets, takes self-damage.",
    scout: "Fast flying recon. Very high vision, low Energy, low attack. Patrols random points continuously.",
    healer_unit: "Support worker. Fetches healing supplies from healer spawners and restores nearby damaged friendly units.",
    researcher_unit: "Research worker. Fetches supplies from research labs and converts them into research progress.",
    astar_collector: "Resource worker. Mines gray A* tiles and refills the shared A* stockpile used by pathfinding.",
};

// Build menu categories
const BUILD_CATEGORIES = {
    barracks: ['barrack_norm', 'barrack_fast', 'barrack_tank', 'barrack_boss', 'barrack_flying', 'barrack_mole', 'barrack_poison_resistant', 'barrack_fire_resistant', 'barrack_water_resistant', 'barrack_ice_resistant', 'barrack_laser_resistant', 'barrack_snake', 'barrack_scout'],
    towers: ['pistol', 'smg', 'water', 'poison', 'fire', 'sand_gun', 'ice', 'sniper', 'elements', 'laser', 'watch_tower'],
    floor: ['sand', 'lava', 'poison_puddle', 'ice_patch', 'water_puddle', 'mine', 'farm', 'astar_farm'],
    special: ['spawner', 'astar_spawner', 'salvager', 'builder_spawner', 'healer_spawner', 'research', 'house', 'area_upgrader', 'cloud_0a', 'cloud_0b', 'cloud_1a', 'cloud_1b', 'cloud_2a', 'cloud_2b', 'cloud_3a', 'cloud_3b'],
};

// Spawn timing config for non-barrack producers and barrack level-reduction rules.
const BARRACK_SPAWN_CONFIG = {
    norm: { baseTime: 40, reduction: 0.10 },
    fast: { baseTime: 20, reduction: 0.10 },
    tank: { baseTime: 80, reduction: 0.08 },
    boss: { baseTime: 400, reduction: 0.06 },
    mole: { baseTime: 10, reduction: 0.12 },
    snake: { baseTime: 800, reduction: 0.05 },
    flying: { baseTime: 45, reduction: 0.09 },
    poison_resistant: { baseTime: 60, reduction: 0.08 },
    fire_resistant: { baseTime: 70, reduction: 0.08 },
    water_resistant: { baseTime: 50, reduction: 0.09 },
    ice_resistant: { baseTime: 65, reduction: 0.08 },
    laser_resistant: { baseTime: 55, reduction: 0.08 },
    scout: { baseTime: 14, reduction: 0.11 },
    collector: { baseTime: 15, reduction: 0.10 },
    astar_collector: { baseTime: 15, reduction: 0.10 },
    salvager_unit: { baseTime: 20, reduction: 0.10 },
    builder_unit: { baseTime: 25, reduction: 0.10 },
    healer_unit: { baseTime: 25, reduction: 0.10 },
    researcher_unit: { baseTime: 25, reduction: 0.10 },
};

// Unit combat stats
const BASE_UNIT_STATS = {
    norm: { energy: 40, price: 400, speed: 2.6, atk: 5, attackRange: 0.5, visionRange: 4, atkCd: 1.5, astarCost: 1, color: '#fff', r: 8, vis: 'circle', attackStyle: 'melee' },
    fast: { energy: 20, price: 200, speed: 4.8, atk: 3, attackRange: 0.5, visionRange: 5, atkCd: 1.0, astarCost: 1, color: '#eee', r: 6, vis: 'circle', attackStyle: 'melee' },
    tank: { energy: 80, price: 800, speed: 1.4, atk: 8, attackRange: 0.5, visionRange: 3, atkCd: 2.25, astarCost: 1, color: '#555', r: 10, vis: 'circle', attackStyle: 'melee' },
    boss: { energy: 400, price: 4000, speed: 1.2, atk: 20, attackRange: 0.5, visionRange: 4, atkCd: 3.0, astarCost: 1, color: '#222', r: 12, vis: 'circle', attackStyle: 'melee' },
    flying: { energy: 45, price: 450, speed: 3.0, atk: 4, attackRange: 1.5, visionRange: 5, atkCd: 1.75, astarCost: 1, color: '#dd0', r: 7, vis: 'triangle', isFlying: true, attackStyle: 'swoop' },
    mole: { energy: 10, price: 100, speed: 1.6, atk: 2, attackRange: 0.5, visionRange: 4, atkCd: 1.25, astarCost: 1, color: '#543', r: 7.5, vis: 'mole', turretImmune: true },
    poison_resistant: { energy: 60, price: 600, speed: 2.4, atk: 6, attackRange: 1.0, visionRange: 4, atkCd: 1.75, astarCost: 1, color: '#2d2', r: 9, vis: 'circle', poisonResistant: true, attackStyle: 'poison' },
    fire_resistant: { energy: 70, price: 700, speed: 2.0, atk: 7, attackRange: 1.0, visionRange: 4, atkCd: 2.0, astarCost: 1, color: '#f50', r: 10, vis: 'circle', fireResistant: true, attackStyle: 'fire' },
    water_resistant: { energy: 50, price: 500, speed: 3.2, atk: 5, attackRange: 1.0, visionRange: 5, atkCd: 1.5, astarCost: 1, color: '#4af', r: 8, vis: 'circle', waterResistant: true, attackStyle: 'water' },
    ice_resistant: { energy: 65, price: 650, speed: 2.2, atk: 6, attackRange: 1.0, visionRange: 4, atkCd: 1.75, astarCost: 1, color: '#afe', r: 9, vis: 'circle', iceResistant: true, attackStyle: 'ice' },
    laser_resistant: { energy: 55, price: 550, speed: 2.3, atk: 5, attackRange: 2.5, visionRange: 4, atkCd: 1.75, astarCost: 1, color: '#d0f', r: 9, vis: 'circle', laserResistant: true, attackStyle: 'laser' },
    snake: { energy: 800, price: 8000, speed: 3.2, atk: 15, attackRange: 0.5, visionRange: 4, atkCd: 1.5, astarCost: 1, color: '#0f0', r: 7, vis: 'snake', isSnake: true, snakeMaxHistory: 20, attackStyle: 'ram' },
    scout: { energy: 14, price: 140, speed: 5.4, atk: 1, attackRange: 0.5, visionRange: 9, atkCd: 1.6, astarCost: 1, color: '#9cf', r: 5.5, vis: 'triangle', isFlying: true, attackStyle: 'swoop' },
    collector: { energy: 15, price: 15, speed: 2.0, atk: 0, attackRange: 0, visionRange: 3, atkCd: 49.95, astarCost: 1, gatherPerTrip: 23, transferCooldown: 2.0, workerSearchDistance: 10, color: '#aaa', r: 6, vis: 'star', isWorker: true },
    astar_collector: { energy: 15, price: 15, speed: 2.0, atk: 0, attackRange: 0, visionRange: 3, atkCd: 49.95, astarCost: 1, gatherPerTrip: 230, transferCooldown: 2.0, workerSearchDistance: 10, color: '#bbb', r: 6, vis: 'star', isWorker: true },
    salvager_unit: { energy: 20, price: 20, speed: 1.8, atk: 0, attackRange: 0, visionRange: 3, atkCd: 49.95, astarCost: 1, transferCooldown: 2.0, workerSearchDistance: 10, color: '#765', r: 6, vis: 'triangle_down', isWorker: true },
    builder_unit: { energy: 25, price: 18, speed: 1.9, atk: 0, attackRange: 0, visionRange: 3, atkCd: 49.95, astarCost: 1, builderDps: 25, transferCooldown: 2.0, workerSearchDistance: 10, color: '#8b5', r: 6, vis: 'rect', isWorker: true },
    healer_unit: { energy: 25, price: 18, speed: 1.9, atk: 0, attackRange: 0, visionRange: 3, atkCd: 49.95, astarCost: 1, healerDps: 5, transferCooldown: 2.0, workerSearchDistance: 10, color: '#fff', r: 6, collisionR: 3, vis: 'triangle', isWorker: true, isFlying: true },
    researcher_unit: { energy: 25, price: 18, speed: 1.9, atk: 0, attackRange: 0, visionRange: 3, atkCd: 49.95, astarCost: 1, researcherDps: 15, transferCooldown: 2.0, workerSearchDistance: 10, color: '#6af', r: 6, collisionR: 3, vis: 'triangle', isWorker: true, isFlying: true },
    king: { energy: 250, price: 1000, speed: 1.8, atk: 12, attackRange: 0.5, visionRange: 5, atkCd: 2.0, astarCost: 1, color: '#ffd700', r: 12, vis: 'king', attackStyle: 'melee' },
};

const UNIT_LEVEL_SCALING = {
    _default: { energyExp: 1.22, dmgExp: 1.16, speedExp: 1.03, speedCapMul: 1.8, cdExp: 0.985, minCd: 0.4, visionExp: 1.02, visionCapBonus: 1.2 },
    boss: { energyExp: 1.36, dmgExp: 1.14, speedExp: 1.015, speedCapAbs: 2.6, cdExp: 0.99, minCd: 0.9, visionExp: 1.015, visionCapBonus: 1.0 },
    flying: { energyExp: 1.12, dmgExp: 1.12, speedExp: 1.06, speedCapAbs: 6.2, cdExp: 0.98, minCd: 0.5, visionExp: 1.03, visionCapBonus: 1.8 },
    snake: { energyExp: 1.24, dmgExp: 1.14, speedExp: 1.03, speedCapAbs: 4.8, cdExp: 0.985, minCd: 0.7, visionExp: 1.02, visionCapBonus: 1.3 },
    tank: { energyExp: 1.25, dmgExp: 1.15, speedExp: 1.02, speedCapAbs: 3.2, cdExp: 0.985, minCd: 0.6, visionExp: 1.02, visionCapBonus: 1.0 },
    scout: { energyExp: 1.1, dmgExp: 1.05, speedExp: 1.04, speedCapAbs: 7.4, cdExp: 0.99, minCd: 0.6, visionExp: 1.04, visionCapBonus: 3.2 },
    collector: { energyExp: 1.13, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.8, cdExp: 1.0, minCd: 49.95, visionExp: 1.015, visionCapBonus: 0.8 },
    astar_collector: { energyExp: 1.13, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.8, cdExp: 1.0, minCd: 49.95, visionExp: 1.015, visionCapBonus: 0.8 },
    salvager_unit: { energyExp: 1.14, dmgExp: 1.0, speedExp: 1.045, speedCapAbs: 4.6, cdExp: 1.0, minCd: 49.95, visionExp: 1.015, visionCapBonus: 0.8 },
    builder_unit: { energyExp: 1.16, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.7, cdExp: 1.0, minCd: 49.95, visionExp: 1.015, visionCapBonus: 0.8 },
    healer_unit: { energyExp: 1.16, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.7, cdExp: 1.0, minCd: 49.95, visionExp: 1.015, visionCapBonus: 0.8 },
    researcher_unit: { energyExp: 1.16, dmgExp: 1.0, speedExp: 1.05, speedCapAbs: 4.7, cdExp: 1.0, minCd: 49.95, visionExp: 1.015, visionCapBonus: 0.8 },
    king: { energyExp: 1.2, dmgExp: 1.12, speedExp: 1.025, speedCapAbs: 3.2, cdExp: 0.99, minCd: 0.6, visionExp: 1.02, visionCapBonus: 1.2 },
};

let RESEARCH_COST_EXP = 3;
let RESEARCH_WORK_EXP = 3;
let RESEARCH_WORK_BASE = 110;
let RESEARCH_BONUS_EXP_UNITS = 2.0;
let RESEARCH_BONUS_EXP_OTHER = 1.25;
let RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP = 1.5;

let MAX_THING_LEVEL = 20;
let MAX_RESEARCH_LEVEL = 10;

const RESEARCH_DECREASE_STATS = { cd: true, atkCd: true, transferCooldown: true, astarCost: true, baseTime: true, spawnCd: true };
const RESEARCH_STAT_LABELS = {
    maxEnergy: 'Max Energy',
    popCap: 'Pop Cap',
    damage: 'Damage',
    blastDamage: 'Blast Damage',
    blastRadius: 'Blast Radius',
    cd: 'Cooldown',
    spawnCd: 'Spawn CD',
    visionRange: 'Vision',
    multiplier: 'Multiplier',
    burnDps: 'Burn DPS',
    burnDuration: 'Burn Duration',
    poisonDps: 'Poison DPS',
    poisonDuration: 'Poison Duration',
    freezeDps: 'Freeze DPS',
    freezeDuration: 'Freeze Duration',
    wetDuration: 'Wet Duration',
    sandDuration: 'Slow Duration',
    watchDuration: 'Watch Duration',
    efficiency: 'Efficiency',
    energy: 'Energy',
    speed: 'Speed',
    atk: 'Attack',
    attackRange: 'Range',
    atkCd: 'Atk Cooldown',
    astarCost: 'A* / Tile',
    transferCooldown: 'Transfer Cooldown',
    workerSearchDistance: 'Work Search Distance',
    gatherPerTrip: 'Gather Speed',
    builderDps: 'Build Speed',
    healerDps: 'Heal Speed',
    researcherDps: 'Research Speed',
    unitPrice: 'Unit Energy'
};

const RESEARCHABLE_UNIT_STATS = {
    _default: ['energy', 'speed', 'atk', 'attackRange', 'visionRange', 'atkCd', 'astarCost'],
    collector: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'gatherPerTrip', 'transferCooldown', 'astarCost'],
    astar_collector: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'gatherPerTrip', 'transferCooldown', 'astarCost'],
    salvager_unit: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'transferCooldown', 'astarCost'],
    builder_unit: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'builderDps', 'transferCooldown', 'astarCost'],
    healer_unit: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'healerDps', 'transferCooldown', 'astarCost'],
    researcher_unit: ['energy', 'speed', 'visionRange', 'workerSearchDistance', 'researcherDps', 'transferCooldown', 'astarCost'],
    king: ['energy', 'speed', 'atk', 'attackRange', 'visionRange', 'atkCd', 'astarCost']
};

const PRECOMPUTED_UNIT_STAT_KEYS = ['energy', 'atk', 'atkCd', 'speed', 'visionRange', 'attackRange', 'workerSearchDistance', 'gatherPerTrip', 'builderDps', 'healerDps', 'researcherDps', 'transferCooldown', 'astarCost'];
const PRECOMPUTED_BUILDING_STAT_KEYS = ['maxEnergy', 'popCap', 'damage', 'blastDamage', 'blastRadius', 'cd', 'spawnCd', 'unitPrice', 'visionRange', 'multiplier', 'burnDps', 'burnDuration', 'poisonDps', 'poisonDuration', 'freezeDps', 'freezeDuration', 'wetDuration', 'sandDuration', 'watchDuration', 'efficiency'];

function getSpawnedUnitTypeForBuildingKey(key) {
    if (!key) return null;
    if (key.startsWith('barrack_')) return (BASE_CARD_TYPES[key] || {}).unitType || 'norm';
    if (key === 'spawner') return 'collector';
    if (key === 'salvager') return 'salvager_unit';
    if (key === 'builder_spawner') return 'builder_unit';
    if (key === 'healer_spawner') return 'healer_unit';
    if (key === 'research') return 'researcher_unit';
    return null;
}

// Soft caps for precomputed stats. Infinity means "no soft cap".
const PRECOMPUTED_SOFT_CAP_MAP = {
    unit: {
        energy: Infinity,
        atk: Infinity,
        atkCd: 0.025,
        speed: ({ baseAtLevel1 }) => {
            let baseSpeed = Number(baseAtLevel1 && baseAtLevel1.speed);
            if (!Number.isFinite(baseSpeed) || baseSpeed <= 0) return 8.5;
            return Math.min(baseSpeed * 3, 8 + baseSpeed / 10);
        },
        visionRange: ({ baseAtLevel1 }) => {
            let baseVision = Number(baseAtLevel1 && baseAtLevel1.visionRange);
            return (Number.isFinite(baseVision) && baseVision > 0) ? (baseVision * 2) : 10;
        },
        attackRange: ({ baseAtLevel1 }) => {
            let baseRange = Number(baseAtLevel1 && baseAtLevel1.attackRange);
            return (Number.isFinite(baseRange) && baseRange > 0) ? (baseRange * 2) : 7;
        },
        gatherPerTrip: Infinity,
        builderDps: Infinity,
        healerDps: Infinity,
        researcherDps: Infinity,
        transferCooldown: 0.3,
        workerSearchDistance: 25,
        astarCost: 0.1,
    },
    building: {
        maxEnergy: Infinity,
        popCap: ({ key }) => key === 'house' ? getConfiguredMaxPop() : Infinity,
        damage: Infinity,
        cd: ({ baseAtLevel1 }) => {
            let baseCd = Number(baseAtLevel1 && baseAtLevel1.cd);
            if (!Number.isFinite(baseCd) || baseCd <= 0) return 0.5;
            return Math.log(baseCd) / Math.log(3);
        },
        spawnCd: ({ baseAtLevel1 }) => {
            let baseSpawnCd = Number(baseAtLevel1 && baseAtLevel1.spawnCd);
            if (!Number.isFinite(baseSpawnCd) || baseSpawnCd <= 0) return 0.5;
            return Math.log(baseSpawnCd) / Math.log(15);
        },
        visionRange: ({ baseAtLevel1 }) => {
            let baseVision = Number(baseAtLevel1 && baseAtLevel1.visionRange);
            return (Number.isFinite(baseVision) && baseVision > 0) ? (baseVision * 1.5) : 16;
        },
        multiplier: ({ key }) => (key === 'farm' || key === 'astar_farm') ? 10 : Infinity,
        efficiency: 3,
    }
};

let PRECOMPUTED_STATS_MAP = { unit: {}, building: {} };
let PRECOMPUTED_STATS_READY = false;

function clampThingLevel(level) {
    return Math.max(0, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 0)));
}

function clampResearchLevel(level) {
    return Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(level) || 0)));
}

function getUnitResearchStatKeys(unitType) {
    return RESEARCHABLE_UNIT_STATS[unitType] || RESEARCHABLE_UNIT_STATS._default;
}

function getResearchBonusExp(kind) {
    return kind === 'unit' ? RESEARCH_BONUS_EXP_UNITS : RESEARCH_BONUS_EXP_OTHER;
}

function getResearchBonusExpForStat(kind, statKey) {
    if (statKey === 'unitPrice') return Math.max(1, Number(RESEARCH_FORMULA_CONFIG.unitPriceBonusExp) || 1);
    if (kind === 'building' && statKey === 'popCap') return Math.max(1, Number(RESEARCH_BONUS_EXP_OTHER_HOUSE_POPCAP) || 2);
    return getResearchBonusExp(kind);
}

function applyResearchLevelToBaseValue(kind, baseValue, statKey, researchLevel) {
    if (!Number.isFinite(baseValue)) return NaN;
    let rLevel = clampResearchLevel(researchLevel);
    let mult = Math.pow(getResearchBonusExpForStat(kind, statKey), rLevel);
    if (RESEARCH_DECREASE_STATS[statKey]) return baseValue / Math.max(1e-6, mult);
    return baseValue * mult;
}

function getPrecomputedSoftCap(kind, key, statKey, context = null) {
    let kindMap = (PRECOMPUTED_SOFT_CAP_MAP && PRECOMPUTED_SOFT_CAP_MAP[kind]) || null;
    if (!kindMap) return Infinity;
    let cap = kindMap[statKey];
    if (typeof cap === 'function') {
        try {
            cap = cap({ kind, key, statKey, ...(context || {}) });
        } catch {
            return Infinity;
        }
    }
    return Number.isFinite(cap) ? Math.max(0, cap) : Infinity;
}

function applyPrecomputedSoftCap(value, cap, statKey, baseValue, maxValueBeforeCap) {
    if (!Number.isFinite(value)) return value;
    if (!Number.isFinite(cap) || cap <= 0) return value;
    if (!Number.isFinite(baseValue) || !Number.isFinite(maxValueBeforeCap)) return value;

    let denom = maxValueBeforeCap - baseValue;
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-9) return value;

    // Preserve multiplicative spacing where possible by projecting the raw value
    // onto the baseline->max segment in log space, then mapping that position to
    // baseline->cap in log space.
    let canUseLog = value > 0 && baseValue > 0 && maxValueBeforeCap > 0 && cap > 0;
    if (canUseLog) {
        let logDenom = Math.log(maxValueBeforeCap / baseValue);
        if (Number.isFinite(logDenom) && Math.abs(logDenom) >= 1e-9) {
            let tLog = Math.log(value / baseValue) / logDenom;
            if (Number.isFinite(tLog)) {
                tLog = Math.max(0, Math.min(1, tLog));
                let logCapSpan = Math.log(cap / baseValue);
                if (Number.isFinite(logCapSpan)) {
                    return baseValue * Math.exp(logCapSpan * tLog);
                }
            }
        }
    }

    // Fallback for non-positive domains or degenerate logarithmic spans.
    let t = (value - baseValue) / denom;
    if (!Number.isFinite(t)) return value;
    t = Math.max(0, Math.min(1, t));
    return baseValue + (cap - baseValue) * t;
}

function getUnitStatFallbackValue(unitType, statKey) {
    let s = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm || {};
    let unitCfg = UNIT_FORMULA_CONFIG || {};
    if (statKey === 'energy') return Math.max(1, Math.floor(Number(s.energy) || 1));
    if (statKey === 'atk') return Math.max(0, Number(s.atk) || 0);
    if (statKey === 'atkCd') return Math.max(0.01, Number(s.atkCd) || Math.max(0.05, Number(unitCfg.baseAttackCooldownFallback) || 1.5));
    if (statKey === 'speed') return Math.max(0.1, Number(s.speed) || Math.max(0.1, Number(unitCfg.baseSpeedFallback) || 1));
    if (statKey === 'visionRange') return Math.max(0.25, Number(s.visionRange) || Math.max(0.25, Number(unitCfg.baseVisionFallback) || 4));
    if (statKey === 'attackRange') return Math.max(0, Number(s.attackRange) || 0);
    if (statKey === 'workerSearchDistance') return s.isWorker ? Math.max(1, Number(s.workerSearchDistance) || 10) : 0;
    if (statKey === 'gatherPerTrip') return Math.max(0, Number(s.gatherPerTrip) || 0);
    if (statKey === 'builderDps') return Math.max(0, Number(s.builderDps) || 0);
    if (statKey === 'healerDps') return Math.max(0, Number(s.healerDps) || 0);
    if (statKey === 'researcherDps') return Math.max(0, Number(s.researcherDps) || 0);
    if (statKey === 'transferCooldown') return s.isWorker ? Math.max(0.01, Number(s.transferCooldown) || 0.01) : 0;
    if (statKey === 'astarCost') return Math.max(0.1, Number(s.astarCost) || 1);
    return NaN;
}

function normalizePrecomputedUnitStatValue(unitType, statKey, value) {
    let s = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm || {};
    let v = Number.isFinite(value) ? value : getUnitStatFallbackValue(unitType, statKey);
    if (statKey === 'energy') return Math.max(1, Math.floor(v));
    if (statKey === 'atk') return Math.max(0, Number(v) || 0);
    if (statKey === 'atkCd') return Math.max(0.01, Number(v) || 0.01);
    if (statKey === 'speed') return Math.max(0.1, Number(v) || 0.1);
    if (statKey === 'visionRange') return Math.max(0.25, Number(v) || 0.25);
    if (statKey === 'attackRange') return Math.max(0, Number(v) || 0);
    if (statKey === 'workerSearchDistance') return s.isWorker ? Math.max(1, Number(v) || 1) : 0;
    if (statKey === 'gatherPerTrip') {
        if (unitType === 'collector' || unitType === 'astar_collector') return Math.max(1, Number(v) || 1);
        return 0;
    }
    if (statKey === 'builderDps') {
        if (unitType === 'builder_unit') return Math.max(1, Math.round(Number(v) || 1));
        return 0;
    }
    if (statKey === 'healerDps') {
        if (unitType === 'healer_unit') return Math.max(1, Math.round(Number(v) || 1));
        return 0;
    }
    if (statKey === 'researcherDps') {
        if (unitType === 'researcher_unit') return Math.max(1, Math.round(Number(v) || 1));
        return 0;
    }
    if (statKey === 'transferCooldown') return s.isWorker ? Math.max(0.01, Number(v) || 0.01) : 0;
    if (statKey === 'astarCost') return Math.max(0.1, Number(v) || 1);
    return v;
}

function computeBaseUnitStatsAtLevel(unitType, level) {
    let s = BASE_UNIT_STATS[unitType] || BASE_UNIT_STATS.norm;
    let lvl = Math.max(1, clampThingLevel(level));
    let cfg = UNIT_LEVEL_SCALING[unitType] || UNIT_LEVEL_SCALING._default;
    let unitCfg = UNIT_FORMULA_CONFIG || {};

    let energyMult = Math.pow(cfg.energyExp || 1, lvl - 1);
    let dmgMult = Math.pow(cfg.dmgExp || 1, lvl - 1);
    let speedMult = Math.pow(cfg.speedExp || 1, lvl - 1);
    let cdMult = Math.pow(cfg.cdExp || 1, lvl - 1);
    let visionMult = Math.pow(cfg.visionExp || 1, lvl - 1);

    let energy = Math.max(1, Math.floor((Number(s.energy) || 1) * energyMult));
    let atk = (Number(s.atk) || 0) > 0 ? Math.max(1, Math.round((Number(s.atk) || 0) * dmgMult)) : 0;

    let baseCd = Number(s.atkCd) || Math.max(0.05, Number(unitCfg.baseAttackCooldownFallback) || 1.5);
    let atkCd = baseCd;
    atkCd = Math.max(cfg.minCd || 0.4, baseCd * cdMult);

    let baseSpeed = Number(s.speed) || Math.max(0.1, Number(unitCfg.baseSpeedFallback) || 1);
    let speedCap = cfg.speedCapAbs !== undefined ? cfg.speedCapAbs : (baseSpeed * (cfg.speedCapMul || 1.8));
    let speed = Math.min(speedCap, baseSpeed * speedMult);

    let baseVisionMin = Math.max(0.01, Number(unitCfg.baseVisionMin) || 0.25);
    let baseVision = Math.max(baseVisionMin, Number(s.visionRange) || Math.max(baseVisionMin, Number(unitCfg.baseVisionFallback) || 4));
    let visionCap = baseVision + (cfg.visionCapBonus || 1.2);
    let visionRange = Math.min(visionCap, baseVision * visionMult);

    let attackRange = Math.max(0, Number(s.attackRange) || 0);
    let workerSearchDistance = s.isWorker ? Math.max(1, Number(s.workerSearchDistance) || 10) : 0;
    let gatherBase = Math.max(0, Number(s.gatherPerTrip) || 0);
    let gatherLvlExp = Math.max(0, Number(unitCfg.collectorGatherLevelExp));
    let gatherPerTrip = (unitType === 'collector' || unitType === 'astar_collector') ? Math.max(1, gatherBase * Math.pow(lvl, gatherLvlExp)) : 0;
    let workerBaseRate = Math.max(0, Number(unitCfg.workerSpecialistBaseRate) || 0);
    let workerGrowthExp = Math.max(1, Number(unitCfg.workerSpecialistLevelExp) || 1);
    let workerTransferCdExp = Math.max(0.01, Number(unitCfg.workerTransferCooldownLevelExp) || 1);
    let astarCostLevelExp = Math.max(1, Number(unitCfg.astarCostLevelExp) || 1.08);
    let builderBase = Math.max(0, Number(s.builderDps) || workerBaseRate);
    let healerBase = Math.max(0, Number(s.healerDps) || workerBaseRate);
    let researcherBase = Math.max(0, Number(s.researcherDps) || workerBaseRate);
    let astarCost = Math.max(0.1, (Number(s.astarCost) || 1) * Math.pow(astarCostLevelExp, lvl - 1));
    let builderDps = unitType === 'builder_unit' ? Math.max(1, Math.round(builderBase * Math.pow(workerGrowthExp, lvl - 1))) : 0;
    let healerDps = unitType === 'healer_unit' ? Math.max(1, Math.round(healerBase * Math.pow(workerGrowthExp, lvl - 1))) : 0;
    let researcherDps = unitType === 'researcher_unit' ? Math.max(1, Math.round(researcherBase * Math.pow(workerGrowthExp, lvl - 1))) : 0;
    let transferCooldown = NaN;
    if (s.isWorker) {
        let baseTransferCooldown = Math.max(0.01, Number(s.transferCooldown) || 0.01);
        transferCooldown = Math.max(0.01, baseTransferCooldown * Math.pow(workerTransferCdExp, lvl - 1));
    }

    return { energy, atk, atkCd, speed, visionRange, attackRange, workerSearchDistance, gatherPerTrip, builderDps, healerDps, researcherDps, transferCooldown, astarCost };
}

function computeBaseBuildingStatsAtLevel(type, level) {
    let key = type || 'farm';
    let lvl = Math.max(1, clampThingLevel(level));
    let bCfg = BUILDING_FORMULA_CONFIG || {};
    let multExp = Math.max(1, Number(bCfg.levelMultExp) || 1);
    let energyExp = Math.max(1, Number(bCfg.energyLevelExp ?? bCfg.energyLevelExp) || 1);
    let damageExp = Math.max(1, Number(bCfg.damageLevelExp) || 1);
    let linearCdReduction = Math.max(0, Math.min(0.95, Number(bCfg.linearCdReductionPerLevel) || 0));
    let linearVisionBonus = Math.max(0, Number(bCfg.linearVisionBonusPerLevel) || 0);
    let sandGunCdExp = Math.max(0.01, Number(bCfg.sandGunCdLevelExp) || 0.01);
    let researchEfficiencyExp = Math.max(1, Number(bCfg.researchEfficiencyLevelExp) || 1);
    let researchEfficiencyCap = Math.max(0, Number(bCfg.researchEfficiencyCap) || 0);
    let mult = Math.pow(multExp, lvl - 1);
    let energyMult = Math.pow(energyExp, lvl - 1);
    let out = {
        maxEnergy: NaN,
        popCap: NaN,
        damage: NaN,
        blastDamage: NaN,
        blastRadius: NaN,
        cd: NaN,
        spawnCd: NaN,
        unitPrice: NaN,
        visionRange: NaN,
        multiplier: NaN,
        burnDps: NaN,
        burnDuration: NaN,
        poisonDps: NaN,
        poisonDuration: NaN,
        freezeDps: NaN,
        freezeDuration: NaN,
        wetDuration: NaN,
        sandDuration: NaN,
        watchDuration: NaN,
        efficiency: NaN,
    };

    let def = BASE_CARD_TYPES[key] || {};
    if (Number.isFinite(def.energy) && def.energy > 0) {
        out.maxEnergy = Math.floor(def.energy * energyMult);
    }

    let spawnUnitType = getSpawnedUnitTypeForBuildingKey(key);
    if (spawnUnitType) {
        let cfg = BARRACK_SPAWN_CONFIG[spawnUnitType] || BARRACK_SPAWN_CONFIG.norm;
        let baseSpawnCd = Number(cfg.baseTime);
        let reduction = Number.isFinite(cfg.reduction) ? cfg.reduction : 0.10;
        if (Number.isFinite(baseSpawnCd) && baseSpawnCd > 0) {
            let spawnCdFloor = Math.max(0.001, Number(bCfg.spawnCdFloor) || 0.001);
            out.spawnCd = Math.max(spawnCdFloor, baseSpawnCd * Math.pow(1 - reduction, lvl - 1));
        }
        let baseUnitPrice = Number((BASE_UNIT_STATS[spawnUnitType] || {}).price);
        if (Number.isFinite(baseUnitPrice) && baseUnitPrice > 0) {
            let priceExp = Math.max(1, Number(bCfg.spawnedUnitPriceLevelExp) || 1);
            out.unitPrice = Math.max(1, baseUnitPrice * Math.pow(priceExp, lvl - 1));
        }
    }

    if (key === 'farm' || key === 'astar_farm') {
        let baseMultiplier = Number.isFinite(def.multiplier) ? def.multiplier : (Number(bCfg.farmBaseMultiplierFallback) || 1);
        let farmPolyCoeff = Number(bCfg.farmLevelPolyCoeff) || 1;
        let farmPowExp = Math.max(0, Number(bCfg.farmLevelPowerExp) || 0);
        out.multiplier = baseMultiplier + Math.floor(farmPolyCoeff * lvl * Math.log(lvl + 1) * Math.pow(lvl, farmPowExp));
    }
    else if (key === 'house') {
        let housePopExp = Math.max(1, Number(bCfg.levelMultExp * 1) || 1);
        out.popCap = Math.pow(housePopExp, lvl) * Math.pow(housePopExp, lvl) * Math.max(1, Math.floor(Math.pow(housePopExp, lvl)));
    }
    else if (key === 'sand') { out.damage = (Number(bCfg.sandFloorDamageBase) || 0) * mult; }
    else if (key === 'lava') { out.damage = (Number(bCfg.lavaFloorDamageBase) || 0) * mult; }
    else if (key === 'mine') { out.damage = Math.floor((Number(bCfg.mineFloorDamageBase) || 0) * mult); }
    else if (key === 'poison_puddle') { out.damage = (Number(bCfg.poisonPuddleFloorDamageBase) || 0) * mult; }
    else if (key === 'ice_patch') { out.damage = (Number(bCfg.icePatchFloorDamageBase) || 0) * mult; }

    if (Number.isFinite(def.damage)) out.damage = def.damage * Math.pow(damageExp, lvl - 1);
    if (Number.isFinite(def.blastDamage)) out.blastDamage = def.blastDamage * Math.pow(damageExp, lvl - 1);
    if (Number.isFinite(def.blastRadius)) out.blastRadius = Math.max(0, def.blastRadius);
    if (Number.isFinite(def.cd)) out.cd = def.cd;
    if (Number.isFinite(def.visionRange)) out.visionRange = def.visionRange;
    if (key === 'research') {
        let baseEfficiency = Number.isFinite(def.efficiency) ? def.efficiency : 1;
        out.efficiency = Math.min(researchEfficiencyCap, baseEfficiency * Math.pow(researchEfficiencyExp, lvl - 1));
    }

    if (key === 'water' || key === 'smg' || key === 'pistol') {
        let towerCdFloor = Math.max(0.001, Number(bCfg.directTowerCdFloor) || 0.001);
        if (Number.isFinite(def.cd)) out.cd = Math.max(towerCdFloor, def.cd * (1 - (lvl - 1) * linearCdReduction));
        if (Number.isFinite(def.visionRange)) out.visionRange = def.visionRange * (1 + (lvl - 1) * linearVisionBonus);
    } else if (key === 'fire' || key === 'poison') {
        if (Number.isFinite(def.visionRange)) out.visionRange = def.visionRange * (1 + (lvl - 1) * linearVisionBonus);
    } else if (key === 'sand_gun') {
        if (Number.isFinite(def.visionRange)) out.visionRange = def.visionRange * (1 + (lvl - 1) * linearVisionBonus);
        if (Number.isFinite(def.cd)) out.cd = def.cd * Math.pow(sandGunCdExp, lvl);
    }
    if (Number.isFinite(def.maxVisionRange) && Number.isFinite(out.visionRange)) {
        out.visionRange = Math.min(out.visionRange, def.maxVisionRange);
    }

    // Status effect stats are first-class precomputed values so research/matrix can use them.
    if (Number.isFinite(out.damage)) {
        let damageRatio = 1;
        if (Number.isFinite(def.damage) && def.damage > 0) {
            damageRatio = out.damage / def.damage;
        }
        let burnDpsParam = Number.isFinite(def.burnDps) ? def.burnDps : def.fireDps;
        let burnDurationParam = Number.isFinite(def.burnDuration) ? def.burnDuration : def.fireDuration;
        if (key === 'fire') {
            let fireBurnDpsMin = Math.max(0, Number(bCfg.fireBurnDpsMin) || 0);
            let fireBurnDmgMul = Math.max(0, Number(bCfg.fireBurnDpsFromDamageMul) || 0);
            let fireBurnDurLevelAdd = Number(bCfg.fireBurnDurationLevelAdd) || 0;
            let fireBurnDurFallbackBase = Number(bCfg.fireBurnDurationFallbackBase) || 0;
            let fireBurnDurFallbackLevelAdd = Number(bCfg.fireBurnDurationFallbackLevelAdd) || 0;
            out.burnDps = Number.isFinite(burnDpsParam)
                ? Math.max(fireBurnDpsMin, burnDpsParam * damageRatio)
                : Math.max(fireBurnDpsMin, out.damage * fireBurnDmgMul);
            out.burnDuration = Number.isFinite(burnDurationParam)
                ? (burnDurationParam + (lvl - 1) * fireBurnDurLevelAdd)
                : (fireBurnDurFallbackBase + lvl * fireBurnDurFallbackLevelAdd);
        } else if (key === 'poison') {
            let poisonDpsMin = Math.max(0, Number(bCfg.poisonDpsMin) || 0);
            let poisonDmgMul = Math.max(0, Number(bCfg.poisonDpsFromDamageMul) || 0);
            let poisonDurLevelAdd = Number(bCfg.poisonDurationLevelAdd) || 0;
            let poisonDurFallbackBase = Number(bCfg.poisonDurationFallbackBase) || 0;
            let poisonDurFallbackLevelAdd = Number(bCfg.poisonDurationFallbackLevelAdd) || 0;
            out.poisonDps = Number.isFinite(def.poisonDps)
                ? Math.max(poisonDpsMin, def.poisonDps * damageRatio)
                : Math.max(poisonDpsMin, out.damage * poisonDmgMul);
            out.poisonDuration = Number.isFinite(def.poisonDuration)
                ? (def.poisonDuration + (lvl - 1) * poisonDurLevelAdd)
                : (poisonDurFallbackBase + lvl * poisonDurFallbackLevelAdd);
        } else if (key === 'ice') {
            let freezeDpsMin = Math.max(0, Number(bCfg.iceFreezeDpsMin) || 0);
            let freezeDmgMul = Math.max(0, Number(bCfg.iceFreezeDpsFromDamageMul) || 0);
            let freezeDurLevelAdd = Number(bCfg.iceFreezeDurationLevelAdd) || 0;
            let freezeDurFallbackBase = Number(bCfg.iceFreezeDurationFallbackBase) || 0;
            let freezeDurFallbackLevelAdd = Number(bCfg.iceFreezeDurationFallbackLevelAdd) || 0;
            out.freezeDps = Number.isFinite(def.freezeDps)
                ? Math.max(freezeDpsMin, def.freezeDps * damageRatio)
                : Math.max(freezeDpsMin, out.damage * freezeDmgMul);
            out.freezeDuration = Number.isFinite(def.freezeDuration)
                ? (def.freezeDuration + (lvl - 1) * freezeDurLevelAdd)
                : (freezeDurFallbackBase + lvl * freezeDurFallbackLevelAdd);
        } else if (key === 'elements') {
            let elementsDotMin = Math.max(0, Number(bCfg.elementsDotMin) || 0);
            let elementsDotMul = Math.max(0, Number(bCfg.elementsDotFromDamageMul) || 0);
            let elementsDurLevelAdd = Number(bCfg.elementsDurationLevelAdd) || 0;
            let elementsDurFallbackBase = Number(bCfg.elementsDurationFallbackBase) || 0;
            let dot = Math.max(elementsDotMin, out.damage * elementsDotMul);
            out.burnDps = Number.isFinite(burnDpsParam) ? Math.max(elementsDotMin, burnDpsParam * damageRatio) : dot;
            out.poisonDps = Number.isFinite(def.poisonDps) ? Math.max(elementsDotMin, def.poisonDps * damageRatio) : dot;
            out.freezeDps = Number.isFinite(def.freezeDps) ? Math.max(elementsDotMin, def.freezeDps * damageRatio) : dot;
            out.burnDuration = Number.isFinite(burnDurationParam) ? (burnDurationParam + (lvl - 1) * elementsDurLevelAdd) : (elementsDurFallbackBase + lvl * elementsDurLevelAdd);
            out.poisonDuration = Number.isFinite(def.poisonDuration) ? (def.poisonDuration + (lvl - 1) * elementsDurLevelAdd) : (elementsDurFallbackBase + lvl * elementsDurLevelAdd);
            out.freezeDuration = Number.isFinite(def.freezeDuration) ? (def.freezeDuration + (lvl - 1) * elementsDurLevelAdd) : (elementsDurFallbackBase + lvl * elementsDurLevelAdd);
        } else if (key === 'lava') {
            let lavaBurnDpsMin = Math.max(0, Number(bCfg.lavaBurnDpsMin) || 0);
            out.burnDps = Number.isFinite(burnDpsParam) ? Math.max(lavaBurnDpsMin, burnDpsParam * mult) : Math.max(lavaBurnDpsMin, out.damage);
            out.burnDuration = Number.isFinite(burnDurationParam) ? burnDurationParam : (Number(bCfg.lavaBurnDurationFallback) || 0);
        } else if (key === 'poison_puddle') {
            let puddlePoisonDpsMin = Math.max(0, Number(bCfg.poisonPuddleDpsMin) || 0);
            out.poisonDps = Number.isFinite(def.poisonDps) ? Math.max(puddlePoisonDpsMin, def.poisonDps * mult) : Math.max(puddlePoisonDpsMin, out.damage);
            out.poisonDuration = Number.isFinite(def.poisonDuration) ? def.poisonDuration : (Number(bCfg.poisonPuddleDurationFallback) || 0);
        } else if (key === 'ice_patch') {
            let patchFreezeDpsMin = Math.max(0, Number(bCfg.icePatchDpsMin) || 0);
            out.freezeDps = Number.isFinite(def.freezeDps) ? Math.max(patchFreezeDpsMin, def.freezeDps * mult) : Math.max(patchFreezeDpsMin, out.damage);
            out.freezeDuration = Number.isFinite(def.freezeDuration) ? def.freezeDuration : (Number(bCfg.icePatchDurationFallback) || 0);
        }
    }

    if (key === 'water' || key === 'water_puddle' || key === 'elements') {
        let waterBase = Number(bCfg.waterWetDurationFallbackBase) || 0;
        let waterLvlAdd = Number(bCfg.waterWetDurationFallbackLevelAdd) || 0;
        let puddleDefaultWet = Number(bCfg.waterPuddleWetDurationFallback) || 0;
        let wetDurationLevelAdd = Number(bCfg.waterWetDurationLevelAdd) || 0;
        let defaultWet = key === 'water' ? (waterBase + lvl * waterLvlAdd) : puddleDefaultWet;
        out.wetDuration = Number.isFinite(def.wetDuration)
            ? (key === 'water' ? (def.wetDuration + (lvl - 1) * wetDurationLevelAdd) : def.wetDuration)
            : defaultWet;
    }
    if (key === 'sand_gun' || key === 'sand' || key === 'elements') {
        let defaultSand = key === 'sand_gun' ? (Number(bCfg.sandGunDurationFallback) || 0) : (Number(bCfg.sandDurationFallback) || 0);
        out.sandDuration = Number.isFinite(def.sandDuration) ? def.sandDuration : defaultSand;
    }
    if (key === 'watch_tower') {
        let watchDurLevelAdd = Number(bCfg.watchDurationLevelAdd) || 0;
        let watchDurFallbackBase = Number(bCfg.watchDurationFallbackBase) || 0;
        out.watchDuration = Number.isFinite(def.watchDuration) ? (def.watchDuration + (lvl - 1) * watchDurLevelAdd) : (watchDurFallbackBase + lvl * watchDurLevelAdd);
    }

    return out;
}

function rebuildPrecomputedStatsMap() {
    PRECOMPUTED_STATS_MAP = { unit: {}, building: {} };

    for (let unitType in BASE_UNIT_STATS) {
        PRECOMPUTED_STATS_MAP.unit[unitType] = [];
        let baseAtLevel1 = computeBaseUnitStatsAtLevel(unitType, 1);
        let baseAtMaxLevel = computeBaseUnitStatsAtLevel(unitType, MAX_THING_LEVEL);
        for (let lvl = 0; lvl <= MAX_THING_LEVEL; lvl++) {
            let base = computeBaseUnitStatsAtLevel(unitType, lvl);
            let levelEntry = {};
            for (let statKey of PRECOMPUTED_UNIT_STAT_KEYS) {
                let arr = new Array(MAX_RESEARCH_LEVEL + 1);
                let cap = getPrecomputedSoftCap('unit', unitType, statKey, { baseAtLevel1, baseAtMaxLevel });
                let baselineValue = applyResearchLevelToBaseValue('unit', baseAtLevel1[statKey], statKey, 0);
                let maxValueBeforeCap = applyResearchLevelToBaseValue('unit', baseAtMaxLevel[statKey], statKey, MAX_RESEARCH_LEVEL);
                for (let r = 0; r <= MAX_RESEARCH_LEVEL; r++) {
                    let researched = applyResearchLevelToBaseValue('unit', base[statKey], statKey, r);
                    let capped = applyPrecomputedSoftCap(researched, cap, statKey, baselineValue, maxValueBeforeCap);
                    arr[r] = normalizePrecomputedUnitStatValue(unitType, statKey, capped);
                }
                levelEntry[statKey] = arr;
            }
            PRECOMPUTED_STATS_MAP.unit[unitType][lvl] = levelEntry;
        }
    }

    for (let buildingKey in BASE_CARD_TYPES) {
        PRECOMPUTED_STATS_MAP.building[buildingKey] = [];
        let baseAtLevel1 = computeBaseBuildingStatsAtLevel(buildingKey, 1);
        let baseAtMaxLevel = computeBaseBuildingStatsAtLevel(buildingKey, MAX_THING_LEVEL);
        for (let lvl = 0; lvl <= MAX_THING_LEVEL; lvl++) {
            let base = computeBaseBuildingStatsAtLevel(buildingKey, lvl);
            let levelEntry = {};
            for (let statKey of PRECOMPUTED_BUILDING_STAT_KEYS) {
                let arr = new Array(MAX_RESEARCH_LEVEL + 1);
                let cap = getPrecomputedSoftCap('building', buildingKey, statKey, { baseAtLevel1, baseAtMaxLevel });
                let baselineValue = applyResearchLevelToBaseValue('building', baseAtLevel1[statKey], statKey, 0);
                let maxValueBeforeCap = applyResearchLevelToBaseValue('building', baseAtMaxLevel[statKey], statKey, MAX_RESEARCH_LEVEL);
                for (let r = 0; r <= MAX_RESEARCH_LEVEL; r++) {
                    let researched = applyResearchLevelToBaseValue('building', base[statKey], statKey, r);
                    arr[r] = applyPrecomputedSoftCap(researched, cap, statKey, baselineValue, maxValueBeforeCap);
                }
                levelEntry[statKey] = arr;
            }
            PRECOMPUTED_STATS_MAP.building[buildingKey][lvl] = levelEntry;
        }
    }

    PRECOMPUTED_STATS_READY = true;
}

function ensurePrecomputedStatsMap() {
    if (!PRECOMPUTED_STATS_READY) rebuildPrecomputedStatsMap();
}

function getUnitStatFromMap(unitType, level, statKey, researchLevel = 0) {
    ensurePrecomputedStatsMap();
    let key = PRECOMPUTED_STATS_MAP.unit[unitType] ? unitType : 'norm';
    let lvl = clampThingLevel(level);
    let rLvl = clampResearchLevel(researchLevel);
    let arr = (((PRECOMPUTED_STATS_MAP.unit[key] || [])[lvl] || {})[statKey] || null);
    if (!arr) return normalizePrecomputedUnitStatValue(key, statKey, NaN);
    return normalizePrecomputedUnitStatValue(key, statKey, arr[rLvl]);
}

function getBuildingStatFromMap(buildingKey, level, statKey, researchLevel = 0) {
    ensurePrecomputedStatsMap();
    let key = PRECOMPUTED_STATS_MAP.building[buildingKey] ? buildingKey : 'farm';
    let lvl = clampThingLevel(level);
    let rLvl = clampResearchLevel(researchLevel);
    let arr = (((PRECOMPUTED_STATS_MAP.building[key] || [])[lvl] || {})[statKey] || null);
    if (!arr) return NaN;
    return arr[rLvl];
}

function getUnitStatForOwner(playerId, unitType, level, statKey) {
    let rLevel = getPlayerResearchLevel(playerId, 'unit', unitType, statKey);
    return getUnitStatFromMap(unitType, level, statKey, rLevel);
}

function getBuildingStatForOwner(playerId, buildingKey, level, statKey) {
    let rLevel = getPlayerResearchLevel(playerId, 'building', buildingKey, statKey);
    return getBuildingStatFromMap(buildingKey, level, statKey, rLevel);
}

function getUnitBaseResearchPrice(unitType) {
    let basePrice = Number((BASE_UNIT_STATS[unitType] || {}).price);
    if (Number.isFinite(basePrice) && basePrice > 0) return Math.max(1, Math.round(basePrice));
    let cfg = BARRACK_SPAWN_CONFIG[unitType];
    if (cfg && Number.isFinite(cfg.baseTime)) return Math.max(1, Math.round(cfg.baseTime * 10));
    return 20;
}

function makeResearchLevelId(kind, key, statKey) {
    return `${kind}:${key}:${statKey}`;
}

function getBaseBuildingmaxEnergyForResearch(buildingKey) {
    if (!buildingKey) return 1;
    let def = BASE_CARD_TYPES[buildingKey] || {};
    if (Number.isFinite(def.energy)) return def.energy;
    return 1;
}

function getResearchStatEntriesForThing(kind, key) {
    let out = [];
    const MIN_VISIBLE_RESEARCH_STAT = 1e-4;
    if (kind === 'unit') {
        let s = BASE_UNIT_STATS[key];
        if (!s) return out;
        let statOrder = getUnitResearchStatKeys(key);
        for (let statKey of statOrder) {
            let baseValue = s[statKey];
            if (!Number.isFinite(baseValue) || Math.abs(baseValue) < MIN_VISIBLE_RESEARCH_STAT) continue;
            out.push({ statKey, label: RESEARCH_STAT_LABELS[statKey] || statKey, baseValue });
        }
        return out;
    }

    let seen = new Set();
    let addStat = (statKey, baseValue) => {
        if (!Number.isFinite(baseValue) || Math.abs(baseValue) < MIN_VISIBLE_RESEARCH_STAT || seen.has(statKey)) return;
        seen.add(statKey);
        out.push({ statKey, label: RESEARCH_STAT_LABELS[statKey] || statKey, baseValue });
    };

    addStat('maxEnergy', getBaseBuildingmaxEnergyForResearch(key));
    addStat('popCap', getBuildingStatFromMap(key, 1, 'popCap', 0));
    let d = BASE_CARD_TYPES[key] || {};
    addStat('damage', d.damage);
    addStat('blastDamage', getBuildingStatFromMap(key, 1, 'blastDamage', 0));
    addStat('blastRadius', getBuildingStatFromMap(key, 1, 'blastRadius', 0));
    addStat('cd', d.cd);
    addStat('spawnCd', getBuildingStatFromMap(key, 1, 'spawnCd', 0));
    addStat('unitPrice', getBuildingStatFromMap(key, 1, 'unitPrice', 0));
    addStat('visionRange', d.visionRange);
    addStat('multiplier', getBuildingStatFromMap(key, 1, 'multiplier', 0));
    addStat('burnDps', getBuildingStatFromMap(key, 1, 'burnDps', 0));
    addStat('burnDuration', getBuildingStatFromMap(key, 1, 'burnDuration', 0));
    addStat('poisonDps', getBuildingStatFromMap(key, 1, 'poisonDps', 0));
    addStat('poisonDuration', getBuildingStatFromMap(key, 1, 'poisonDuration', 0));
    addStat('freezeDps', getBuildingStatFromMap(key, 1, 'freezeDps', 0));
    addStat('freezeDuration', getBuildingStatFromMap(key, 1, 'freezeDuration', 0));
    addStat('wetDuration', getBuildingStatFromMap(key, 1, 'wetDuration', 0));
    addStat('sandDuration', getBuildingStatFromMap(key, 1, 'sandDuration', 0));
    addStat('watchDuration', getBuildingStatFromMap(key, 1, 'watchDuration', 0));
    addStat('efficiency', getBuildingStatFromMap(key, 1, 'efficiency', 0));
    return out;
}

const RESEARCH_THINGS = (() => {
    let things = [];
    for (let key in BASE_CARD_TYPES) {
        let def = BASE_CARD_TYPES[key];
        if (!def || !Number.isFinite(def.price) || def.price <= 0) continue;
        if (key === 'area_upgrader') continue;
        let stats = getResearchStatEntriesForThing('building', key);
        if (stats.length <= 0) continue;
        things.push({
            kind: 'building',
            key,
            label: def.name || key,
            basePrice: Math.max(1, Math.floor(def.price)),
            stats
        });
    }
    for (let key in BASE_UNIT_STATS) {
        let stats = getResearchStatEntriesForThing('unit', key);
        if (stats.length <= 0) continue;
        things.push({
            kind: 'unit',
            key,
            label: key.replace(/_/g, ' '),
            basePrice: getUnitBaseResearchPrice(key),
            stats
        });
    }
    return things;
})();

const RESEARCH_THINGS_BY_ID = (() => {
    let out = {};
    for (let t of RESEARCH_THINGS) out[`${t.kind}:${t.key}`] = t;
    return out;
})();

function getResearchThing(kind, key) {
    return RESEARCH_THINGS_BY_ID[`${kind}:${key}`] || null;
}

function getResearchStatEntry(kind, key, statKey) {
    let thing = getResearchThing(kind, key);
    if (!thing) return null;
    return (thing.stats || []).find(s => s.statKey === statKey) || null;
}

function ensurePlayerResearchLevels(playerId) {
    if (!players[playerId]) return {};
    if (!players[playerId].researchLevels || typeof players[playerId].researchLevels !== 'object') {
        players[playerId].researchLevels = {};
    }
    return players[playerId].researchLevels;
}

function ensurePlayerResearchMultipliers(playerId) {
    if (!players[playerId]) return {};
    if (!players[playerId].researchMultipliers || typeof players[playerId].researchMultipliers !== 'object') {
        players[playerId].researchMultipliers = {};
    }
    return players[playerId].researchMultipliers;
}

function getPlayerResearchLevel(playerId, kind, key, statKey) {
    let levels = ensurePlayerResearchLevels(playerId);
    let id = makeResearchLevelId(kind, key, statKey);
    return clampResearchLevel(levels[id] || 0);
}

function getResearchMultiplier(playerId, kind, key, statKey) {
    if (!statKey) return 1;
    let mults = ensurePlayerResearchMultipliers(playerId);
    let id = makeResearchLevelId(kind, key, statKey);
    if (!Number.isFinite(mults[id])) {
        mults[id] = Math.pow(getResearchBonusExpForStat(kind, statKey), getPlayerResearchLevel(playerId, kind, key, statKey));
    }
    return Math.max(1, mults[id]);
}

function applyResearchMultiplierToValue(baseValue, mult, statKey) {
    if (!Number.isFinite(baseValue)) return baseValue;
    if (RESEARCH_DECREASE_STATS[statKey]) return baseValue / Math.max(1e-6, mult);
    return baseValue * mult;
}

function formatResearchStatValue(statKey, value) {
    if (!Number.isFinite(value)) return '-';
    let compact = (v, d = 2) => formatBigNumber(v, d);
    if (statKey === 'burnDuration' || statKey === 'poisonDuration' || statKey === 'freezeDuration' || statKey === 'wetDuration' || statKey === 'sandDuration' || statKey === 'watchDuration') {
        return `${compact(value, 2)}s`;
    }
    if (statKey === 'burnDps' || statKey === 'poisonDps' || statKey === 'freezeDps') return compact(value, 2);
    if (statKey === 'blastDamage') return compact(value, 2);
    if (statKey === 'blastRadius') return `${compact(value, 2)} tiles`;
    if (statKey === 'workerSearchDistance') return `${compact(value, 2)} tiles`;
    if (statKey === 'speed' || statKey === 'attackRange' || statKey === 'visionRange' || statKey === 'multiplier' || statKey === 'astarCost') return compact(value, 2);
    if (statKey === 'efficiency') return compact(value, 2);
    if (statKey === 'spawnCd') return `${compact(value, 2)}s`;
    if (statKey === 'builderDps' || statKey === 'healerDps' || statKey === 'researcherDps' || statKey === 'gatherPerTrip') return compact(value, 1);
    if (statKey === 'cd' || statKey === 'atkCd' || statKey === 'transferCooldown') return `${compact(value, 2)}s`;
    return compact(value, 0);
}

function formatResearchMultiplierValue(mult) {
    if (!Number.isFinite(mult)) return '-';
    return formatBigNumber(mult, 2);
}

function getResearchBuildingEfficiency(researchBuilding) {
    if (!researchBuilding || researchBuilding.type !== 'research') return 1;
    let lvl = Math.max(1, getThingEffectiveLevel(researchBuilding));
    let owner = Number.isFinite(researchBuilding.owner) ? researchBuilding.owner : localPlayerId;
    let mapped = getBuildingStatForOwner(owner, 'research', lvl, 'efficiency');
    if (Number.isFinite(mapped)) return Math.max(0, mapped);
    let baseEfficiency = Number((BASE_CARD_TYPES.research || {}).efficiency);
    return Number.isFinite(baseEfficiency) ? Math.max(0, baseEfficiency) : 1;
}

function getResearchCurrentStatValue(playerId, kind, key, statKey) {
    let rLevel = getPlayerResearchLevel(playerId, kind, key, statKey);
    if (kind === 'unit') return getUnitStatFromMap(key, 1, statKey, rLevel);
    if (kind === 'building') return getBuildingStatFromMap(key, 1, statKey, rLevel);
    return NaN;
}

function getEffectiveCardTypeForPlayer(playerId, key) {
    let base = BASE_CARD_TYPES[key];
    if (!base) return null;
    let out = { ...base };
    for (let stat of getResearchStatEntriesForThing('building', key)) {
        let val = getResearchCurrentStatValue(playerId, 'building', key, stat.statKey);
        if (!Number.isFinite(val)) continue;
        if (stat.statKey === 'maxEnergy') {
            out.energy = val;
            if (Number.isFinite(base.towerEnergy)) out.towerEnergy = val;
        } else {
            out[stat.statKey] = val;
        }
    }
    return out;
}

function getEffectiveUnitStatsForPlayer(playerId, key) {
    let base = BASE_UNIT_STATS[key];
    if (!base) return null;
    let out = { ...base };
    for (let stat of getResearchStatEntriesForThing('unit', key)) {
        let val = getResearchCurrentStatValue(playerId, 'unit', key, stat.statKey);
        if (Number.isFinite(val)) out[stat.statKey] = val;
    }
    return out;
}

function getResearchStatCostWeight(kind, key, statKey, currentLevel) {
    let stat = getResearchStatEntry(kind, key, statKey);
    if (!stat) return 1;

    let lvl = Math.max(0, Math.floor(currentLevel || 0));
    let baseValue = getResearchStatValueAtLevel(kind, key, statKey, 0, 1);
    if (!Number.isFinite(baseValue)) baseValue = Number(stat.baseValue);

    let value = getResearchStatValueAtLevel(kind, key, statKey, lvl, 1);
    if (!Number.isFinite(value)) value = baseValue;

    let orientedBase = RESEARCH_DECREASE_STATS[statKey]
        ? (1 / Math.max(1e-6, Math.abs(baseValue || 0)))
        : Math.abs(baseValue || 0);
    let orientedValue = RESEARCH_DECREASE_STATS[statKey]
        ? (1 / Math.max(1e-6, Math.abs(value || 0)))
        : Math.abs(value || 0);

    if (!Number.isFinite(orientedBase) || orientedBase <= 0) orientedBase = 1;
    if (!Number.isFinite(orientedValue) || orientedValue <= 0) orientedValue = orientedBase;

    // Normalize different stat scales while still rewarding higher-value upgrades.
    let magnitudeNorm = Math.log10(1 + orientedBase);
    let relativeNorm = Math.max(1, orientedValue / orientedBase);
    let weight = Math.pow(1 + magnitudeNorm, 0.85) * Math.pow(relativeNorm, 0.65);

    return Math.max(0.1, Math.min(1000, weight));
}

function getResearchCost(kind, key, statKey, currentLevel) {
    let thing = getResearchThing(kind, key);
    let stat = getResearchStatEntry(kind, key, statKey);
    if (!thing || !stat) return 0;
    let lvl = Math.max(0, Math.floor(currentLevel || 0));
    if (lvl >= MAX_RESEARCH_LEVEL) return 0;
    let weight = getResearchStatCostWeight(kind, key, statKey, lvl);
    return Math.max(1, Math.floor(RESEARCH_WORK_BASE * weight * Math.pow(RESEARCH_COST_EXP, lvl)));
}

function getResearchWork(kind, key, statKey, currentLevel) {
    let thing = getResearchThing(kind, key);
    let stat = getResearchStatEntry(kind, key, statKey);
    if (!thing || !stat) return 0;
    let lvl = Math.max(0, Math.floor(currentLevel || 0));
    if (lvl >= MAX_RESEARCH_LEVEL) return 0;
    let weight = getResearchStatCostWeight(kind, key, statKey, lvl);
    return Math.max(1, Math.floor(RESEARCH_WORK_BASE * weight * Math.pow(RESEARCH_WORK_EXP, lvl)));
}

function ensurePlayerResearchQueueState(playerId) {
    if (!players[playerId]) return { researchQueue: [], researchTask: null };
    if (!Array.isArray(players[playerId].researchQueue)) players[playerId].researchQueue = [];
    if (!Object.prototype.hasOwnProperty.call(players[playerId], 'researchTask')) players[playerId].researchTask = null;
    return players[playerId];
}

function getPlayerResearchQueue(playerId) {
    return ensurePlayerResearchQueueState(playerId).researchQueue;
}

function getPlayerResearchTask(playerId) {
    return ensurePlayerResearchQueueState(playerId).researchTask;
}

function getResearchQueueCapacityForPlayer(playerId) {
    let labs = 0;
    for (let s of collectorSpawners) {
        if (!s || s.type !== 'research' || s.owner !== playerId || s.energy <= 0) continue;
        labs++;
    }
    return Math.max(0, labs * 20);
}

function getPlayerResearchQueueTotalLength(playerId) {
    let queue = getPlayerResearchQueue(playerId);
    let task = getPlayerResearchTask(playerId);
    return (task ? 1 : 0) + queue.length;
}

function tryAdvancePlayerResearchTask(playerId) {
    let p = ensurePlayerResearchQueueState(playerId);
    if (!p.researchTask && p.researchQueue.length > 0) {
        p.researchTask = p.researchQueue.shift();
        if (p.researchTask) p.researchTask.workDone = Math.max(0, p.researchTask.workDone || 0);
    }
    return p.researchTask;
}

function getResearchQueueDepthForStat(researchBuilding, kind, key, statKey) {
    if (!researchBuilding) return 0;
    let owner = researchBuilding.owner;
    if (!Number.isFinite(owner)) return 0;
    let task = getPlayerResearchTask(owner);
    let queue = getPlayerResearchQueue(owner);
    let n = 0;
    if (task && task.kind === kind && task.key === key && task.statKey === statKey) n++;
    for (let q of queue) {
        if (q && q.kind === kind && q.key === key && q.statKey === statKey) n++;
    }
    return n;
}

function getResearchQueuedDepthForPlayer(playerId, kind, key, statKey) {
    let task = getPlayerResearchTask(playerId);
    let queue = getPlayerResearchQueue(playerId);
    let n = 0;
    if (task && task.kind === kind && task.key === key && task.statKey === statKey) n++;
    for (let q of queue) {
        if (q && q.kind === kind && q.key === key && q.statKey === statKey) n++;
    }
    return n;
}

function makeResearchTask(owner, kind, key, statKey, projectedLevel) {
    let lvl = Math.max(0, Math.floor(projectedLevel || 0));
    return {
        owner,
        kind,
        key,
        statKey,
        fromLevel: lvl,
        toLevel: lvl + 1,
        cost: getResearchCost(kind, key, statKey, lvl),
        workRequired: getResearchWork(kind, key, statKey, lvl),
        workDone: 0
    };
}

function applyUnitResearchUpgradeToExistingUnits(owner, unitType, statKey) {
    for (let u of units) {
        if (!u || u.dead || u.owner !== owner || u.unitType !== unitType) continue;
        let prevEnergy = u.energy;
        applyUnitLevelScaling(u, getUnitBaseLevel(u));
        if (statKey === 'energy') u.energy = Math.max(1, Math.min(prevEnergy, u.maxEnergy));
    }
}

function applyBuildingResearchUpgradeToExisting(owner, buildingKey, statKey) {
    for (let t of towers) {
        if (!t || t.owner !== owner || t.type !== buildingKey) continue;
        let prevEnergy = t.energy;
        t.updateStats();
        if (statKey === 'maxEnergy') t.energy = Math.max(1, Math.min(prevEnergy, t.maxEnergy));
    }

    for (let b of barracks) {
        if (!b || b.owner !== owner || `barrack_${b.unitType}` !== buildingKey) continue;
        let prevEnergy = b.energy;
        let lvl = getThingEffectiveLevel(b);
        let stats = calculateItemStats(`barrack_${b.unitType}`, lvl, b.owner);
        b.maxEnergy = Math.max(1, Math.floor(stats.maxEnergy || 1));
        if (statKey === 'maxEnergy') b.energy = Math.max(1, Math.min(prevEnergy, b.maxEnergy));
    }

    for (let s of collectorSpawners) {
        if (!s || s.owner !== owner || s.type !== buildingKey) continue;
        let prevEnergy = s.energy;
        let lvl = getThingEffectiveLevel(s);
        let stats = calculateItemStats(s.type, lvl, s.owner);
        s.maxEnergy = Math.max(1, Math.floor(stats.maxEnergy || 1));
        if (statKey === 'maxEnergy') s.energy = Math.max(1, Math.min(prevEnergy, s.maxEnergy));
    }

    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y][x];
            if (!cell || !cell.item || cell.owner !== owner) continue;
            let item = cell.item;
            if (item.type !== buildingKey) continue;
            let prevEnergy = item.energy;
            let lvl = getThingEffectiveLevel(item);
            let stats = calculateItemStats(item.type, lvl, owner);
            if (Number.isFinite(stats.maxEnergy) && stats.maxEnergy > 0) {
                item.maxEnergy = Math.max(1, Math.floor(stats.maxEnergy));
                if (statKey === 'maxEnergy') item.energy = Math.max(1, Math.min(prevEnergy, item.maxEnergy));
            }
            if (Number.isFinite(stats.damage)) item.damage = stats.damage;
        }
    }
}

function applyResearchCompletion(owner, task) {
    if (!task) return;
    let levels = ensurePlayerResearchLevels(owner);
    let mults = ensurePlayerResearchMultipliers(owner);
    let id = makeResearchLevelId(task.kind, task.key, task.statKey);
    let prevLevel = clampResearchLevel(levels[id] || 0);
    let nextLevel = clampResearchLevel(prevLevel + 1);
    if (nextLevel <= prevLevel) return;
    levels[id] = nextLevel;
    mults[id] = Math.pow(getResearchBonusExp(task.kind), nextLevel);
    if (task.kind === 'unit') applyUnitResearchUpgradeToExistingUnits(owner, task.key, task.statKey);
    if (task.kind === 'building') applyBuildingResearchUpgradeToExisting(owner, task.key, task.statKey);
    if (task.kind === 'building' && task.key === 'house' && task.statKey === 'popCap') {
        recomputePlayerPopCaps();
    }
    recalculateAdjacency();
}

function completeActiveResearchTaskForPlayer(owner, completedTask) {
    if (!Number.isFinite(owner) || !completedTask) return;
    let p = ensurePlayerResearchQueueState(owner);
    if (p.researchTask !== completedTask) return;
    applyResearchCompletion(owner, completedTask);
    p.researchTask = null;
    tryAdvancePlayerResearchTask(owner);
}

function getResearchQueueTotalLength(researchBuilding) {
    if (!researchBuilding || !Number.isFinite(researchBuilding.owner)) return 0;
    return getPlayerResearchQueueTotalLength(researchBuilding.owner);
}

function computeUnitLevelScaledStats(unit, level) {
    if (!unit) return null;
    let lvl = Math.max(1, clampThingLevel(level || 1));
    let unitType = unit.unitType || 'norm';
    let owner = Number.isFinite(unit.owner) ? unit.owner : localPlayerId;

    let maxEnergy = getUnitStatForOwner(owner, unitType, lvl, 'energy');
    let attackDamage = getUnitStatForOwner(owner, unitType, lvl, 'atk');
    let attackCooldownSec = getUnitStatForOwner(owner, unitType, lvl, 'atkCd');
    let speed = getUnitStatForOwner(owner, unitType, lvl, 'speed');
    let visionRange = getUnitStatForOwner(owner, unitType, lvl, 'visionRange');
    let attackRangeTiles = getUnitStatForOwner(owner, unitType, lvl, 'attackRange');
    let gatherPerTrip = getUnitStatForOwner(owner, unitType, lvl, 'gatherPerTrip');
    let builderDps = getUnitStatForOwner(owner, unitType, lvl, 'builderDps');
    let healerDps = getUnitStatForOwner(owner, unitType, lvl, 'healerDps');
    let researcherDps = getUnitStatForOwner(owner, unitType, lvl, 'researcherDps');
    let transferCooldownSec = getUnitStatForOwner(owner, unitType, lvl, 'transferCooldown');
    let astarCost = getUnitStatForOwner(owner, unitType, lvl, 'astarCost');

    let attackCooldown = secondsToTicks(attackCooldownSec);
    let attackRange = attackRangeTiles * TILE;
    let transferCooldownTicks = unit.workerType ? secondsToTicks(transferCooldownSec) : 0;

    return {
        level: lvl,
        maxEnergy,
        attackDamage,
        attackCooldown,
        speed,
        visionRange,
        attackRange,
        gatherPerTrip,
        builderDps,
        healerDps,
        researcherDps,
        transferCooldownSec,
        transferCooldownTicks,
        astarCost
    };
}

function applyUnitLevelScaling(unit, level) {
    if (!unit) return;
    let lvl = Math.max(1, Math.floor(level || 1));
    unit.unitLevel = lvl;
    let shouldSyncStackFromLevel = !(Number.isFinite(unit.stackCount) && unit.stackCount >= 1)
        || !Number.isFinite(unit.baseLevel)
        || Math.max(1, Math.floor(unit.baseLevel || 1)) !== lvl;
    if (shouldSyncStackFromLevel) {
        unit.stackCount = getRequiredStacksForLevel(lvl);
    }

    unit.baseEnergy = unit.baseEnergy || unit.maxEnergy || 1;
    unit.baseAttackDamage = unit.baseAttackDamage || unit.attackDamage || 0;
    unit.baseSpeed = unit.baseSpeed || unit.speed || 1;
    unit.baseAttackCooldown = unit.baseAttackCooldown || unit.attackCooldown || 30;
    unit.baseVisionRange = unit.baseVisionRange || unit.visionRange || 4;
    if (!Number.isFinite(unit.baseAttackRange)) unit.baseAttackRange = (Number(unit.attackRange) || 0) / TILE;

    let scaled = computeUnitLevelScaledStats(unit, lvl);
    if (!scaled) return;

    let prevEnergyAbs = Number(unit.energy);
    if (!Number.isFinite(prevEnergyAbs)) prevEnergyAbs = Number(scaled.maxEnergy) || 1;
    unit.maxEnergy = scaled.maxEnergy;
    unit.energy = Math.max(1, Math.min(unit.maxEnergy, Math.floor(prevEnergyAbs)));
    unit.attackDamage = scaled.attackDamage;
    unit.attackCooldown = scaled.attackCooldown;
    unit.speed = scaled.speed;
    unit.visionRange = scaled.visionRange;
    unit.attackRange = scaled.attackRange;
    unit.astarCost = scaled.astarCost;
    if (unit.workerType === 'collector' || unit.workerType === 'astar_collector') unit.gatherPerTrip = scaled.gatherPerTrip;
    if (unit.workerType === 'builder') unit.builderDps = scaled.builderDps;
    if (unit.workerType === 'healer') unit.healerDps = scaled.healerDps;
    if (unit.workerType === 'researcher') unit.researcherDps = scaled.researcherDps;
    if (unit.workerType) {
        unit.transferCooldownSec = scaled.transferCooldownSec;
        unit.transferCooldownTicks = scaled.transferCooldownTicks;
    }

    unit.baseLevel = lvl;
    unit.baseLevelmaxEnergy = scaled.maxEnergy;
    unit.baseLevelAttackDamage = scaled.attackDamage;
    unit.baseLevelAttackCooldown = scaled.attackCooldown;
    unit.baseLevelSpeed = scaled.speed;
    unit.baseLevelVisionRange = scaled.visionRange;
    unit.baseLevelAttackRange = scaled.attackRange / TILE;
    unit.baseLevelAstarCost = scaled.astarCost;
    if (unit.workerType === 'collector' || unit.workerType === 'astar_collector') unit.baseLevelGatherPerTrip = scaled.gatherPerTrip;
    if (unit.workerType === 'builder') unit.baseLevelBuilderDps = scaled.builderDps;
    if (unit.workerType === 'healer') unit.baseLevelhealerDps = scaled.healerDps;
    if (unit.workerType === 'researcher') unit.baseLevelResearcherDps = scaled.researcherDps;

    unit.effectiveStacks = Math.max(1, Number.isFinite(unit.stackCount) ? Math.floor(unit.stackCount) : 1);
    unit.effectiveLevel = lvl;
}

function applyUnitEffectiveScaling(unit, effectiveLevel) {
    if (!unit) return;
    let lvl = Math.max(1, Math.floor(effectiveLevel || 1));
    let scaled = computeUnitLevelScaledStats(unit, lvl);
    if (!scaled) return;

    let prevEnergyAbs = Number(unit.energy);
    if (!Number.isFinite(prevEnergyAbs)) prevEnergyAbs = Number(scaled.maxEnergy) || 1;
    unit.maxEnergy = scaled.maxEnergy;
    unit.energy = Math.max(1, Math.min(unit.maxEnergy, Math.floor(prevEnergyAbs)));
    unit.attackDamage = scaled.attackDamage;
    unit.attackCooldown = scaled.attackCooldown;
    unit.speed = scaled.speed;
    unit.visionRange = scaled.visionRange;
    unit.attackRange = scaled.attackRange;
    unit.astarCost = scaled.astarCost;
    if (unit.workerType === 'collector' || unit.workerType === 'astar_collector') unit.gatherPerTrip = scaled.gatherPerTrip;
    if (unit.workerType === 'builder') unit.builderDps = scaled.builderDps;
    if (unit.workerType === 'healer') unit.healerDps = scaled.healerDps;
    if (unit.workerType === 'researcher') unit.researcherDps = scaled.researcherDps;
    if (unit.workerType) {
        unit.transferCooldownSec = scaled.transferCooldownSec;
        unit.transferCooldownTicks = scaled.transferCooldownTicks;
    }

    unit.effectiveLevel = lvl;
}
