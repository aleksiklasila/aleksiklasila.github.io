
// ============================================================
// UI
// ============================================================
let _hudCache = { energy: -1, astarText: '', popText: '', time: -1, fps: -1, tps: -1 };
let infoPanelShowPing = true;
let infoPanelShowHostRemoveButtons = true;
let _hudEls = {};
const ENERGY_DELTA_WINDOW_OPTIONS = [1, 10, 30, 60];
const ENERGY_DELTA_DEFAULT_WINDOW_SECONDS = 10;
const ENERGY_DELTA_LOG_MAX_SECONDS = 70;
const ASTAR_USAGE_LOG_MAX_SECONDS = 70;
let infoPanelSectionCollapsed = {
    energyDelta: false,
    astarBudget: false,
    idleWorkers: false
};
let infoPanelEnergyDeltaWindowSecByMetric = {
    total: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    collect: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    salvage: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    research: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    builder: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    healer: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
};
let infoPanelAstarWindowSecByMetric = {
    total: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    king: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    collector: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    salvager: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    builder: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    healer: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    researcher: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
    other: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
};
let energyDeltaEventLogByPlayer = Array.from({ length: 8 }, () => []);
let astarUsageEventLogByPlayer = Array.from({ length: 8 }, () => []);

function _normalizeOwnerId(owner) {
    let idx = Math.floor(Number(owner));
    if (!Number.isFinite(idx) || idx < 0 || idx >= players.length) return -1;
    return idx;
}

function _ensureAstarLogPlayer(owner) {
    let idx = _normalizeOwnerId(owner);
    if (idx < 0) return null;
    if (!Array.isArray(astarUsageEventLogByPlayer[idx])) astarUsageEventLogByPlayer[idx] = [];
    return astarUsageEventLogByPlayer[idx];
}

function _astarMetricKeyForUnitType(unitType) {
    if (unitType === 'king') return 'king';
    if (unitType === 'collector') return 'collector';
    if (unitType === 'salvager_unit') return 'salvager';
    if (unitType === 'builder_unit') return 'builder';
    if (unitType === 'healer_unit') return 'healer';
    if (unitType === 'researcher_unit') return 'researcher';
    return String(unitType || 'other');
}

function _getAstarBudgetIdleCooldownTicks() {
    return Math.max(8, Math.floor(TICK_RATE * 0.7));
}

function _getEnergyBlockedGlyphTicks() {
    return Math.max(8, Math.floor(TICK_RATE * 0.9));
}

function _getAstarBlockedGlyphTicks() {
    return Math.max(8, Math.floor(TICK_RATE * 0.9));
}

function ensureEnergyDeltaLogPlayer(owner) {
    let idx = Math.floor(Number(owner));
    if (!Number.isFinite(idx) || idx < 0) return null;
    if (!Array.isArray(energyDeltaEventLogByPlayer[idx])) energyDeltaEventLogByPlayer[idx] = [];
    return energyDeltaEventLogByPlayer[idx];
}

function resetEnergyDeltaTracking() {
    energyDeltaEventLogByPlayer = Array.from({ length: players.length || 8 }, () => []);
    astarUsageEventLogByPlayer = Array.from({ length: players.length || 8 }, () => []);
}

function _isInfoSectionCollapsed(sectionKey) {
    return !!infoPanelSectionCollapsed[String(sectionKey || '')];
}

function _toggleInfoSectionCollapsed(sectionKey) {
    let key = String(sectionKey || '');
    infoPanelSectionCollapsed[key] = !infoPanelSectionCollapsed[key];
    return !!infoPanelSectionCollapsed[key];
}

function _buildCollapsibleInfoSectionTitle(sectionKey, title) {
    let collapsed = _isInfoSectionCollapsed(sectionKey);
    let arrow = collapsed ? '▸' : '▾';
    return `<div class="info-title info-section-toggle" data-section-key="${sectionKey}" style="margin-bottom:2px;cursor:pointer;user-select:none">${arrow} ${title}</div>`;
}

function _getWindowSecondsForMetric(windowState, metric) {
    let key = String(metric || '').toLowerCase();
    let value = Number(windowState[key]);
    if (!ENERGY_DELTA_WINDOW_OPTIONS.includes(value)) value = ENERGY_DELTA_DEFAULT_WINDOW_SECONDS;
    return value;
}

function _cycleWindowSecondsForMetric(windowState, metric) {
    let key = String(metric || '').toLowerCase();
    let cur = _getWindowSecondsForMetric(windowState, key);
    let idx = ENERGY_DELTA_WINDOW_OPTIONS.indexOf(cur);
    let next = ENERGY_DELTA_WINDOW_OPTIONS[(idx + 1) % ENERGY_DELTA_WINDOW_OPTIONS.length];
    windowState[key] = next;
    return next;
}

function getEnergyDeltaWindowSeconds(metric) {
    return _getWindowSecondsForMetric(infoPanelEnergyDeltaWindowSecByMetric, metric);
}

function cycleEnergyDeltaWindowSeconds(metric) {
    return _cycleWindowSecondsForMetric(infoPanelEnergyDeltaWindowSecByMetric, metric);
}

function getAstarWindowSeconds(metric) {
    return _getWindowSecondsForMetric(infoPanelAstarWindowSecByMetric, metric);
}

function cycleAstarWindowSeconds(metric) {
    return _cycleWindowSecondsForMetric(infoPanelAstarWindowSecByMetric, metric);
}

function recordEnergyDelta(owner, source, delta) {
    let d = Number(delta);
    if (!Number.isFinite(d) || Math.abs(d) <= 1e-9) return;
    let bucket = ensureEnergyDeltaLogPlayer(owner);
    if (!bucket) return;
    bucket.push({ tick: gameTime, source: String(source || ''), delta: d });
    let pruneBefore = gameTime - Math.max(1, Math.floor(TICK_RATE * ENERGY_DELTA_LOG_MAX_SECONDS));
    while (bucket.length > 0 && Number(bucket[0].tick) < pruneBefore) bucket.shift();
}

function getPlayerEnergyDeltaRate(owner, sourceKey, windowSeconds) {
    let bucket = ensureEnergyDeltaLogPlayer(owner);
    if (!bucket || bucket.length === 0) return 0;

    let sec = Math.max(1, Number(windowSeconds) || ENERGY_DELTA_DEFAULT_WINDOW_SECONDS);
    let windowTicks = Math.max(1, Math.floor(TICK_RATE * sec));
    let cutoffTick = gameTime - windowTicks;

    let pruneBefore = gameTime - Math.max(windowTicks * 2, Math.floor(TICK_RATE * ENERGY_DELTA_LOG_MAX_SECONDS));
    while (bucket.length > 0 && Number(bucket[0].tick) < pruneBefore) bucket.shift();

    let sum = 0;
    for (let i = 0; i < bucket.length; i++) {
        let ev = bucket[i];
        if (!ev || !Number.isFinite(ev.tick) || ev.tick < cutoffTick) continue;
        if (sourceKey && ev.source !== sourceKey) continue;
        let d = Number(ev.delta) || 0;
        sum += d;
    }

    // Always present values as energy-per-second regardless of window length.
    return sum / sec;
}

function buildInfoPanelEnergyDeltaHtml(owner) {
    if (!Number.isFinite(owner) || owner < 0 || owner >= players.length) return '';

    let fmt = (v) => {
        if (!Number.isFinite(v) || Math.abs(v) < 0.05) return '0.0';
        return `${v > 0 ? '+' : ''}${formatBigNumber(v, 1)}`;
    };
    let color = (v) => {
        if (v > 0.05) return '#6f6';
        if (v < -0.05) return '#f88';
        return '#dd6';
    };
    let row = (metric, label, sourceKey) => {
        let sec = getEnergyDeltaWindowSeconds(metric);
        let value = getPlayerEnergyDeltaRate(owner, sourceKey, sec);
        return `<div class="info-row" style="margin:0;gap:8px;align-items:center">`
            + `<button class="info-energy-delta-window-btn" data-metric="${metric}" title="Window: ${sec}s (click to cycle 1s/10s/30s/60s)" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center">${sec}s</button>`
            + `<span class="info-label" style="color:#bbb;min-width:68px">${label}:</span>`
            + `<span class="info-value" style="color:${color(value)}">${fmt(value)} ⚡/s</span>`
            + `</div>`;
    };

    let html = _buildCollapsibleInfoSectionTitle('energyDelta', 'Energy Delta');
    if (!_isInfoSectionCollapsed('energyDelta')) {
        html += row('total', 'Total', '');
        html += row('collect', 'Collect', 'collect');
        html += row('salvage', 'Salvage', 'salvage');
        html += row('research', 'Research', 'research');
        html += row('builder', 'Builder', 'builder');
        html += row('healer', 'Healer', 'healer');
    }
    html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    return html;
}

function _getPlayerAstarUsageRate(owner, windowSeconds, matcherFn) {
    let bucket = _ensureAstarLogPlayer(owner);
    if (!bucket || bucket.length === 0) return 0;
    let sec = Math.max(1, Number(windowSeconds) || ENERGY_DELTA_DEFAULT_WINDOW_SECONDS);
    let windowTicks = Math.max(1, Math.floor(TICK_RATE * sec));
    let cutoffTick = gameTime - windowTicks;
    let pruneBefore = gameTime - Math.max(windowTicks * 2, Math.floor(TICK_RATE * ASTAR_USAGE_LOG_MAX_SECONDS));
    while (bucket.length > 0 && Number(bucket[0].tick) < pruneBefore) bucket.shift();
    let sum = 0;
    for (let i = 0; i < bucket.length; i++) {
        let ev = bucket[i];
        if (!ev || !Number.isFinite(ev.tick) || ev.tick < cutoffTick) continue;
        if (matcherFn && !matcherFn(ev)) continue;
        sum += Math.max(0, Number(ev.used) || 0);
    }
    return sum / sec;
}

function _prettyUnitTypeLabel(unitType) {
    if (unitType === 'collector') return 'Collector';
    if (unitType === 'astar_collector') return 'A*er';
    if (unitType === 'salvager_unit') return 'Salvager';
    if (unitType === 'builder_unit') return 'Builder';
    if (unitType === 'healer_unit') return 'Healer';
    if (unitType === 'researcher_unit') return 'Researcher';
    if (unitType === 'king') return 'King';
    return String(unitType || 'Other').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function buildInfoPanelAstarBudgetHtml(owner) {
    if (!Number.isFinite(owner) || owner < 0 || owner >= players.length) return '';

    let fmtBudget = (v) => {
        if (!Number.isFinite(v) || Math.abs(v) < 0.05) return '0.0';
        return `${v > 0 ? '+' : ''}${formatBigNumber(v, 1)}`;
    };
    let fmtUsage = (v) => {
        if (!Number.isFinite(v) || Math.abs(v) < 0.05) return '-0.0';
        return `-${formatBigNumber(Math.abs(v), 1)}`;
    };
    let colorBudget = (v) => {
        if (v < -0.05) return '#f88';
        if (v > 0.05) return '#8f8';
        return '#9aa';
    };
    let colorUsage = (v) => {
        if (v > 0.05) return '#8cf';
        return '#9aa';
    };
    let secBtn = (metric, sec) => `<button class="info-astar-window-btn" data-metric="${metric}" title="Window: ${sec}s (click to cycle 1s/10s/30s/60s)" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center">${sec}s</button>`;

    let usageRow = (metric, label, matcherFn) => {
        let sec = getAstarWindowSeconds(metric);
        let value = _getPlayerAstarUsageRate(owner, sec, matcherFn);
        return `<div class="info-row" style="margin:0;gap:8px;align-items:center">`
            + secBtn(metric, sec)
            + `<span class="info-label" style="color:#bbb;min-width:68px">${label}:</span>`
            + `<span class="info-value" style="color:${colorUsage(value)}">${fmtUsage(value)} ★/s</span>`
            + `</div>`;
    };

    let html = _buildCollapsibleInfoSectionTitle('astarBudget', '★ Budget');
    if (!_isInfoSectionCollapsed('astarBudget')) {
        let totalSec = getAstarWindowSeconds('total');
        let totalUsedRate = _getPlayerAstarUsageRate(owner, totalSec, null);
        let stockCur = Math.max(0, Number(_getPlayerAstarBudgetRemaining(owner)) || 0);
        html += `<div class="info-row" style="margin:0;gap:8px;align-items:center">`
            + `<span class="info-label" style="color:#bbb;min-width:68px">Stock:</span>`
            + `<span class="info-value" style="color:#ddd">${formatBigNumber(stockCur, 1)} ★</span>`
            + `</div>`;
        html += `<div class="info-row" style="margin:0;gap:8px;align-items:center">`
            + secBtn('total', totalSec)
            + `<span class="info-label" style="color:#bbb;min-width:68px">Spend:</span>`
            + `<span class="info-value" style="color:${colorBudget(-totalUsedRate)}">${fmtBudget(-totalUsedRate)} ★/s</span>`
            + `</div>`;

        html += usageRow('king', 'King', ev => ev.unitMetric === 'king');
        html += usageRow('collector', 'Collector', ev => ev.unitMetric === 'collector');
        html += usageRow('salvager', 'Salvager', ev => ev.unitMetric === 'salvager');
        html += usageRow('builder', 'Builder', ev => ev.unitMetric === 'builder');
        html += usageRow('healer', 'Healer', ev => ev.unitMetric === 'healer');
        html += usageRow('researcher', 'Researcher', ev => ev.unitMetric === 'researcher');

        let special = new Set(['king', 'collector', 'salvager_unit', 'builder_unit', 'healer_unit', 'researcher_unit']);
        let otherTypes = new Set();
        for (let u of units) {
            if (!u || u.dead || u.owner !== owner) continue;
            if (special.has(u.unitType)) continue;
            otherTypes.add(String(u.unitType || 'other'));
        }
        let sortedOtherTypes = Array.from(otherTypes).sort();
        for (let unitType of sortedOtherTypes) {
            let metric = `u_${unitType}`;
            html += usageRow(metric, _prettyUnitTypeLabel(unitType), ev => ev.unitType === unitType);
        }
    }
    html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    return html;
}

function buildInfoPanelIdleWorkersHtml(owner) {
    if (!Number.isFinite(owner) || owner < 0 || owner >= players.length) return '';

    let idleCounts = {
        total: 0,
        collector: 0,
        astarCollector: 0,
        salvager: 0,
        researcher: 0,
        builder: 0,
        healer: 0
    };

    let totalCounts = {
        total: 0,
        collector: 0,
        astarCollector: 0,
        salvager: 0,
        researcher: 0,
        builder: 0,
        healer: 0
    };
    let hasFastWorkerTotals = false;

    if (owner >= 0 && owner < spatialUnitsComplexPlayerCount && spatialUnitsComplexStridePerChunk > 0 && spatialUnitsComplexStridePerPlayer > 0 && spatialUnitsComplex.length > 0) {
        hasFastWorkerTotals = true;
        let collectorIdx = spatialUnitTypeToIndex.collector;
        let astarCollectorIdx = spatialUnitTypeToIndex.astar_collector;
        let salvagerIdx = spatialUnitTypeToIndex.salvager_unit;
        let researcherIdx = spatialUnitTypeToIndex.researcher_unit;
        let builderIdx = spatialUnitTypeToIndex.builder_unit;
        let healerIdx = spatialUnitTypeToIndex.healer_unit;

        let chunkCount = CHUNKS_W * CHUNKS_H;
        for (let chunkKey = 0; chunkKey < chunkCount; chunkKey++) {
            let playerBase = (chunkKey * spatialUnitsComplexStridePerChunk) + (owner * spatialUnitsComplexStridePerPlayer);
            totalCounts.total += spatialUnitsComplex[playerBase] || 0;
            if (Number.isFinite(collectorIdx)) totalCounts.collector += spatialUnitsComplex[playerBase + 1 + collectorIdx] || 0;
            if (Number.isFinite(astarCollectorIdx)) totalCounts.astarCollector += spatialUnitsComplex[playerBase + 1 + astarCollectorIdx] || 0;
            if (Number.isFinite(salvagerIdx)) totalCounts.salvager += spatialUnitsComplex[playerBase + 1 + salvagerIdx] || 0;
            if (Number.isFinite(researcherIdx)) totalCounts.researcher += spatialUnitsComplex[playerBase + 1 + researcherIdx] || 0;
            if (Number.isFinite(builderIdx)) totalCounts.builder += spatialUnitsComplex[playerBase + 1 + builderIdx] || 0;
            if (Number.isFinite(healerIdx)) totalCounts.healer += spatialUnitsComplex[playerBase + 1 + healerIdx] || 0;
        }
    }

    for (let u of units) {
        if (!u || u.dead || u.owner !== owner || !u.workerType) continue;

        if (!hasFastWorkerTotals) {
            totalCounts.total++;
            if (u.workerType === 'collector') totalCounts.collector++;
            else if (u.workerType === 'astar_collector') totalCounts.astarCollector++;
            else if (u.workerType === 'salvager') totalCounts.salvager++;
            else if (u.workerType === 'researcher') totalCounts.researcher++;
            else if (u.workerType === 'builder') totalCounts.builder++;
            else if (u.workerType === 'healer') totalCounts.healer++;
        }

        let isIdleLike = (u.workerState === 'IDLE') || (u.commandState === CMD_HOLDING);
        if (!isIdleLike) continue;
        idleCounts.total++;
        if (u.workerType === 'collector') idleCounts.collector++;
        else if (u.workerType === 'astar_collector') idleCounts.astarCollector++;
        else if (u.workerType === 'salvager') idleCounts.salvager++;
        else if (u.workerType === 'researcher') idleCounts.researcher++;
        else if (u.workerType === 'builder') idleCounts.builder++;
        else if (u.workerType === 'healer') idleCounts.healer++;
    }

    let row = (label, idleValue, totalValue) => {
        return `<div class="info-row" style="margin:0;gap:8px;align-items:center">`
            + `<span class="info-label" style="color:#bbb;min-width:68px">${label}:</span>`
            + `<span class="info-value" style="color:#ddd">${idleValue} / ${totalValue}</span>`
            + `</div>`;
    };

    let html = _buildCollapsibleInfoSectionTitle('idleWorkers', 'Idle Workers');
    if (!_isInfoSectionCollapsed('idleWorkers')) {
        html += row('Total', idleCounts.total, totalCounts.total);
        html += row('Collector', idleCounts.collector, totalCounts.collector);
        html += row('A*er', idleCounts.astarCollector, totalCounts.astarCollector);
        html += row('Salvager', idleCounts.salvager, totalCounts.salvager);
        html += row('Researcher', idleCounts.researcher, totalCounts.researcher);
        html += row('Builder', idleCounts.builder, totalCounts.builder);
        html += row('Healer', idleCounts.healer, totalCounts.healer);
    }
    html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    return html;
}

function updateHUD() {
    if (!_hudEls.energy) {
        _hudEls.energy = document.getElementById('hud-energy');
        _hudEls.astar = document.getElementById('hud-astar');
        _hudEls.pop = document.getElementById('hud-pop');
        _hudEls.time = document.getElementById('hud-time');
        _hudEls.fps = document.getElementById('hud-fps');
    }
    let p = players[localPlayerId];
    let energy = Math.floor(p.energy);
    if (_hudCache.energy !== energy) { _hudCache.energy = energy; _hudEls.energy.textContent = `⚡ ${formatBigNumber(energy)}`; }
    let astarCur = Math.max(0, Math.floor(_getPlayerAstarBudgetRemaining(localPlayerId)));
    let astarText = `★ ${formatBigNumber(astarCur)}`;
    if (_hudCache.astarText !== astarText && _hudEls.astar) { _hudCache.astarText = astarText; _hudEls.astar.textContent = astarText; }
    let playerCap = getPlayerPopCap(localPlayerId);
    let cfgCap = getConfiguredMaxPop();
    let popText = `Pop: ${String(p.popCount)}/${String(playerCap)}/${String(cfgCap)}`;
    if (_hudCache.popText !== popText) { _hudCache.popText = popText; _hudEls.pop.textContent = popText; }
    let secs = Math.floor(gameTime / TICK_RATE);
    if (_hudCache.time !== secs) { _hudCache.time = secs; let m = Math.floor(secs / 60), s = secs % 60; _hudEls.time.textContent = `${m}:${s.toString().padStart(2, '0')}`; }
    if (_hudCache.fps !== _fpsDisplay || _hudCache.tps !== _tpsDisplay) {
        _hudCache.fps = _fpsDisplay;
        _hudCache.tps = _tpsDisplay;
        _hudEls.fps.textContent = `${_fpsDisplay} FPS / ${_tpsDisplay} TPS (v3)`;
    }
}

let _buildMenuTab = null;
let _buildMenuItems = {}; // key -> div element
let _buildMenuPriceSpans = {}; // key -> price span element
let _buildMenuNeedsRefresh = true;
let appFullscreen = false;

function requestBuildMenuRefresh() {
    _buildMenuNeedsRefresh = true;
}

function bindInstantPress(el, handler, opts = null) {
    if (!el || typeof handler !== 'function') return;
    let invoke = (ev) => {
        if (ev.type === 'mousedown' && ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        handler(ev);
    };

    let onLongPress = opts && typeof opts.onLongPress === 'function' ? opts.onLongPress : null;
    if (!onLongPress) {
        el.addEventListener('mousedown', invoke);
        el.addEventListener('touchstart', invoke, { passive: false });
        return;
    }

    el.addEventListener('mousedown', invoke);

    let longPressMs = Math.max(120, (opts && Number.isFinite(opts.longPressMs)) ? opts.longPressMs : 320);
    let moveTolerance = Math.max(6, (opts && Number.isFinite(opts.longPressMoveTolerance)) ? opts.longPressMoveTolerance : 14);
    let touchId = null;
    let startX = 0;
    let startY = 0;
    let longPressTimer = null;
    let longPressTriggered = false;

    let clearLongPress = () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    };

    let getTouchById = (touchList, id) => {
        if (id === null || !touchList) return null;
        for (let i = 0; i < touchList.length; i++) {
            if (touchList[i].identifier === id) return touchList[i];
        }
        return null;
    };

    el.addEventListener('touchstart', (ev) => {
        if (!ev.changedTouches || ev.changedTouches.length === 0) return;
        let t = ev.changedTouches[0];
        touchId = t.identifier;
        startX = t.clientX;
        startY = t.clientY;
        longPressTriggered = false;
        clearLongPress();
        longPressTimer = setTimeout(() => {
            longPressTimer = null;
            longPressTriggered = true;
            ev.preventDefault();
            ev.stopPropagation();
            onLongPress(ev);
        }, longPressMs);
    }, { passive: false });

    el.addEventListener('touchmove', (ev) => {
        if (touchId === null || !longPressTimer) return;
        let t = getTouchById(ev.touches, touchId) || getTouchById(ev.changedTouches, touchId);
        if (!t) return;
        let dx = t.clientX - startX;
        let dy = t.clientY - startY;
        if (Math.hypot(dx, dy) > moveTolerance) {
            clearLongPress();
        }
    }, { passive: false });

    let finishTouch = (ev) => {
        let wasActive = getTouchById(ev.changedTouches, touchId);
        if (!wasActive) return;
        clearLongPress();
        if (!longPressTriggered) {
            ev.preventDefault();
            ev.stopPropagation();
            handler(ev);
        }
        touchId = null;
        longPressTriggered = false;
    };

    el.addEventListener('touchend', finishTouch, { passive: false });
    el.addEventListener('touchcancel', finishTouch, { passive: false });
}

function updateSelectedBuildDescription() {
    let descEl = document.getElementById('build-selected-desc');
    if (!descEl) return;
    descEl.style.display = 'none';
    if (!selectedBuildItem) {
        descEl.classList.add('empty');
        descEl.textContent = '';
        updateShopStatsInMinimap();
        return;
    }
    descEl.classList.remove('empty');
    descEl.textContent = '';
    updateShopStatsInMinimap();
}

function _computeCloudUnavailableSet(playerId = localPlayerId) {
    let unavailable = new Set();
    for (let t of towers) {
        if (!t || t.owner !== playerId || !(t.energy > 0)) continue;
        if (!t.type || !t.type.startsWith('cloud_')) continue;
        unavailable.add(t.type);
    }
    return unavailable;
}

function updateShopStatsInMinimap() {
    let mapCont = document.getElementById('minimap-container');
    let statsCont = document.getElementById('shop-stats-container');
    let titleEl = document.getElementById('minimap-title');
    let btnMap = document.getElementById('btn-minimap');
    if (!mapCont || !statsCont || !btnMap) return;

    let isCollapsed = btnMap.innerText === '\u25B2';
    if (!selectedBuildItem) {
        statsCont.style.display = 'none';
        statsCont.innerHTML = '';
        mapCont.style.display = isCollapsed ? 'none' : 'block';
        if (titleEl) titleEl.textContent = 'Map';
        return;
    }

    let def = BASE_CARD_TYPES[selectedBuildItem] || {};
    let desc = DESCRIPTIONS[selectedBuildItem] || (def.name || selectedBuildItem);
    statsCont.innerHTML = `<div class="shop-stats-title">${def.name || selectedBuildItem} Stats</div>${renderBuildItemDetailedStats(selectedBuildItem)}<div class="shop-stats-desc">${desc}</div>`;
    bindShopStatsMatrixButtons(statsCont);
    mapCont.style.display = 'none';
    statsCont.style.display = isCollapsed ? 'none' : 'block';
    if (titleEl) titleEl.textContent = 'Shop Stats';
}

function renderBuildItemDetailedStats(key) {
    let def = BASE_CARD_TYPES[key];
    if (!def) return '';

    shopStatMatrixDescriptorById = {};
    nextShopStatMatrixDescriptorId = 1;

    let stacks = Math.max(1, Math.floor(buildPurchaseMultiplier || 1));
    let level = stackCountToLevel(stacks);
    let html = '<div class="build-stats-panel">';
    let thingName = def.name || key;

    let addRow = (label, value, opts = null) => {
        let o = opts || {};
        let id = nextShopStatMatrixDescriptorId++;
        shopStatMatrixDescriptorById[id] = {
            title: `${thingName} / ${label}`,
            kind: o.kind || '',
            key: o.key || '',
            statKey: o.statKey || '',
            fixedValue: value,
            getValue: (typeof o.getValue === 'function') ? o.getValue : null,
        };
        html += `<div class="build-stat-row"><button type="button" class="build-stat-matrix-btn" data-matrix-id="${id}" title="Open level/research matrix">M</button><span class="build-stat-label">${label}</span><span class="build-stat-value">${value}</span></div>`;
    };

    let fmt = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v)) ? formatBigNumber(v, d) : v;
    let getLevelMatrixCostWorkText = (thingLevel, researchLevel) => {
        let tl = Math.max(1, clampThingLevel(thingLevel));
        let rl = Math.max(0, clampResearchLevel(researchLevel));
        let work = getBuildingStatFromMap(key, tl, 'maxEnergy', rl);
        if (!Number.isFinite(work)) {
            let fallbackStats = calculateItemStats(key, tl, localPlayerId);
            work = Number.isFinite(fallbackStats.maxEnergy) ? fallbackStats.maxEnergy : 0;
        }
        return `⚡${formatBigNumber(Math.max(0, Math.round(work)))}`;
    };

    let getUnitDpsForMatrix = (unitType, thingLevel, researchLevel) => {
        let tl = Math.max(1, clampThingLevel(thingLevel));
        let rl = Math.max(0, clampResearchLevel(researchLevel));
        let atk = getUnitStatFromMap(unitType, tl, 'atk', rl);
        let cd = getUnitStatFromMap(unitType, tl, 'atkCd', rl);
        if (!Number.isFinite(atk) || !Number.isFinite(cd) || cd <= 0) return '0';
        return formatBigNumber(atk / cd, 1);
    };

    let getBuildingDpsForMatrix = (buildingKey, thingLevel, researchLevel) => {
        let tl = Math.max(1, clampThingLevel(thingLevel));
        let rl = Math.max(0, clampResearchLevel(researchLevel));
        let dmg = getBuildingStatFromMap(buildingKey, tl, 'damage', rl);
        let cd = getBuildingStatFromMap(buildingKey, tl, 'cd', rl);
        if (!Number.isFinite(dmg) || !Number.isFinite(cd) || cd <= 0) return '0';
        return formatBigNumber(dmg / cd, 1);
    };

    let getUnitPreview = (unitType, lvl) => {
        let safeLvl = Math.max(1, clampThingLevel(lvl));
        let energy = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'energy');
        let atk = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'atk');
        let cd = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'atkCd');
        let speed = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'speed');
        let range = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'attackRange');
        let vision = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'visionRange');
        let gatherPerTrip = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'gatherPerTrip');
        let builderDps = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'builderDps');
        let healerDps = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'healerDps');
        let researcherDps = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'researcherDps');
        let transferCooldown = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'transferCooldown');
        return {
            energy: Math.max(1, Math.floor(Number(energy) || 1)),
            atk: Math.max(0, Math.floor(Number(atk) || 0)),
            cd: Math.max(0.05, Number(cd) || 0.05),
            speed: Math.max(0.1, Number(speed) || 0.1),
            range: Math.max(0, Number(range) || 0),
            vision: Math.max(0.1, Number(vision) || 0.1),
            gatherPerTrip: Math.max(0, Number(gatherPerTrip) || 0),
            builderDps: Math.max(0, Number(builderDps) || 0),
            healerDps: Math.max(0, Number(healerDps) || 0),
            researcherDps: Math.max(0, Number(researcherDps) || 0),
            transferCooldown: Math.max(0.01, Number(transferCooldown) || Number((BASE_UNIT_STATS[unitType] || {}).transferCooldown) || 0.01)
        };
    };

    addRow('Stacks', `x${stacks}`, {
        getValue: (thingLevel) => `x${getRequiredStacksForLevel(thingLevel)}`
    });
    addRow('Level', `L${level}`, {
        getValue: (thingLevel, researchLevel) => getLevelMatrixCostWorkText(thingLevel, researchLevel)
    });

    if (key.startsWith('barrack_')) {
        let unitType = def.unitType || 'norm';
        let bStats = calculateItemStats(key, level, localPlayerId);
        let up = getUnitPreview(unitType, level);
        addRow('Energy', `${fmt(bStats.maxEnergy)}/${fmt(bStats.maxEnergy)}`, { kind: 'building', key, statKey: 'maxEnergy' });
        addRow('Unit Energy', fmt(up.energy), { kind: 'unit', key: unitType, statKey: 'energy' });
        if (unitType === 'builder_unit') addRow('Build Speed', `${fmt(up.builderDps, 1)}/trip`, { kind: 'unit', key: unitType, statKey: 'builderDps' });
        else if (unitType === 'healer_unit') addRow('Heal Speed', `${fmt(up.healerDps, 1)}/trip`, { kind: 'unit', key: unitType, statKey: 'healerDps' });
        else if (unitType === 'collector') addRow('Gather Speed', `${fmt(up.gatherPerTrip, 1)}/trip`, { kind: 'unit', key: unitType, statKey: 'gatherPerTrip' });
        else if (unitType === 'salvager_unit') addRow('Salvage Yield', `10% x L${level}`);
        else {
            addRow('Unit Attack', fmt(up.atk), { kind: 'unit', key: unitType, statKey: 'atk' });
            let dps = up.cd > 0 ? formatBigNumber(up.atk / up.cd, 1) : '0';
            addRow('Unit DPS', dps, {
                getValue: (thingLevel, researchLevel) => getUnitDpsForMatrix(unitType, thingLevel, researchLevel)
            });
        }
        if (unitType === 'collector' || unitType === 'salvager_unit' || unitType === 'builder_unit' || unitType === 'healer_unit' || unitType === 'researcher_unit') {
            addRow('Transfer CD', `${up.transferCooldown.toFixed(2)}s`, { kind: 'unit', key: unitType, statKey: 'transferCooldown' });
        }
        addRow('Unit Range', up.range > 0 ? up.range.toFixed(1) : '-', { kind: 'unit', key: unitType, statKey: 'attackRange' });
        addRow('Unit Vision', up.vision.toFixed(1), { kind: 'unit', key: unitType, statKey: 'visionRange' });
        addRow('Unit Speed', up.speed.toFixed(1), { kind: 'unit', key: unitType, statKey: 'speed' });
    } else if (key === 'spawner' || key === 'astar_spawner' || key === 'salvager' || key === 'builder_spawner' || key === 'healer_spawner' || key === 'research') {
        let workerType = key === 'spawner'
            ? 'collector'
            : (key === 'astar_spawner'
                ? 'astar_collector'
                : (key === 'salvager'
                    ? 'salvager_unit'
                    : (key === 'builder_spawner'
                        ? 'builder_unit'
                        : (key === 'healer_spawner' ? 'healer_unit' : 'researcher_unit'))));
        let stats = calculateItemStats(key, level, localPlayerId);
        let up = getUnitPreview(workerType, level);
        addRow('Energy', `${fmt(stats.maxEnergy)}/${fmt(stats.maxEnergy)}`, { kind: 'building', key, statKey: 'maxEnergy' });
        addRow(key === 'research' ? 'Researcher Energy' : 'Worker Energy', fmt(up.energy), { kind: 'unit', key: workerType, statKey: 'energy' });
        if (workerType === 'builder_unit') addRow('Build Speed', `${fmt(up.builderDps, 1)}/trip`, { kind: 'unit', key: workerType, statKey: 'builderDps' });
        else if (workerType === 'healer_unit') addRow('Heal Speed', `${fmt(up.healerDps, 1)}/trip`, { kind: 'unit', key: workerType, statKey: 'healerDps' });
        else if (workerType === 'researcher_unit') addRow('Research Speed', `${fmt(up.researcherDps, 1)}/trip`, { kind: 'unit', key: workerType, statKey: 'researcherDps' });
        else if (workerType === 'collector') addRow('Gather Speed', `${fmt(up.gatherPerTrip, 1)}/trip`, { kind: 'unit', key: workerType, statKey: 'gatherPerTrip' });
        else if (workerType === 'astar_collector') addRow('A* Gather', `${fmt(up.gatherPerTrip, 1)}/trip`, { kind: 'unit', key: workerType, statKey: 'gatherPerTrip' });
        else addRow('Salvage Yield', `10% x L${level}`);
        addRow('Transfer CD', `${up.transferCooldown.toFixed(2)}s`, { kind: 'unit', key: workerType, statKey: 'transferCooldown' });
        addRow(key === 'research' ? 'Researcher Vision' : 'Worker Vision', up.vision.toFixed(1), { kind: 'unit', key: workerType, statKey: 'visionRange' });
        addRow(key === 'research' ? 'Researcher Speed' : 'Worker Speed', up.speed.toFixed(1), { kind: 'unit', key: workerType, statKey: 'speed' });
        if (key === 'research') {
            let efficiency = getBuildingStatForOwner(localPlayerId, key, level, 'efficiency');
            if (Number.isFinite(efficiency)) addRow('Efficiency', efficiency.toFixed(2), { kind: 'building', key, statKey: 'efficiency' });
        }
    } else if (def.target === 'wall') {
        let energy = getBuildingStatForOwner(localPlayerId, key, level, 'maxEnergy');
        let dmg = getBuildingStatForOwner(localPlayerId, key, level, 'damage');
        let cd = getBuildingStatForOwner(localPlayerId, key, level, 'cd');
        let vision = getBuildingStatForOwner(localPlayerId, key, level, 'visionRange');
        if (!Number.isFinite(energy)) energy = Math.floor((def.towerEnergy || 0) * Math.pow(1.4, level - 1));
        if (!Number.isFinite(dmg)) dmg = null;
        if (!Number.isFinite(cd)) cd = def.cd;
        if (!Number.isFinite(vision)) vision = def.visionRange;
        if (energy > 0) addRow('Energy', `${fmt(energy)}/${fmt(energy)}`, { kind: 'building', key, statKey: 'maxEnergy' });
        if (dmg !== null) addRow('Attack', fmt(dmg, 1), { kind: 'building', key, statKey: 'damage' });
        if (cd) {
            addRow('Cooldown', `${cd.toFixed(2)}s`, { kind: 'building', key, statKey: 'cd' });
            let dps = dmg !== null && cd > 0 ? formatBigNumber(dmg / cd, 1) : '0';
            addRow('DPS', dps, {
                getValue: (thingLevel, researchLevel) => getBuildingDpsForMatrix(key, thingLevel, researchLevel)
            });
        }
        if (key === 'laser') {
            let laserMaxTilesBetween = Math.max(1, clampThingLevel(level));
            addRow('Range', String(laserMaxTilesBetween), {
                getValue: (thingLevel) => String(Math.max(1, clampThingLevel(thingLevel)))
            });
            if (vision !== undefined) addRow('Vision', fmt(vision, 1), { kind: 'building', key, statKey: 'visionRange' });
        } else if (vision !== undefined) {
            addRow('Range', fmt(vision, 1), { kind: 'building', key, statKey: 'visionRange' });
            addRow('Vision', fmt(vision, 1), { kind: 'building', key, statKey: 'visionRange' });
        }
        if (dmg !== null) {
            if (key === 'fire') {
                let burnDps = getBuildingStatForOwner(localPlayerId, key, level, 'burnDps');
                let burnDuration = getBuildingStatForOwner(localPlayerId, key, level, 'burnDuration');
                let blastDamage = getBuildingStatForOwner(localPlayerId, key, level, 'blastDamage');
                let blastRadius = getBuildingStatForOwner(localPlayerId, key, level, 'blastRadius');
                addRow('Burn DPS', Number.isFinite(burnDps) ? burnDps.toFixed(2) : '0', { kind: 'building', key, statKey: 'burnDps' });
                addRow('Burn Duration', Number.isFinite(burnDuration) ? `${burnDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'burnDuration' });
                if (Number.isFinite(blastDamage) && Number.isFinite(blastRadius) && blastDamage > 0 && blastRadius > 0) {
                    addRow('Blast Damage', blastDamage.toFixed(2), { kind: 'building', key, statKey: 'blastDamage' });
                    addRow('Blast Radius', `${blastRadius.toFixed(2)} tiles`, { kind: 'building', key, statKey: 'blastRadius' });
                }
            } else if (key === 'poison') {
                let poisonDps = getBuildingStatForOwner(localPlayerId, key, level, 'poisonDps');
                let poisonDuration = getBuildingStatForOwner(localPlayerId, key, level, 'poisonDuration');
                addRow('Poison DPS', Number.isFinite(poisonDps) ? poisonDps.toFixed(2) : '0', { kind: 'building', key, statKey: 'poisonDps' });
                addRow('Poison Duration', Number.isFinite(poisonDuration) ? `${poisonDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'poisonDuration' });
            } else if (key === 'ice') {
                let freezeDps = getBuildingStatForOwner(localPlayerId, key, level, 'freezeDps');
                let freezeDuration = getBuildingStatForOwner(localPlayerId, key, level, 'freezeDuration');
                addRow('Freeze DPS', Number.isFinite(freezeDps) ? freezeDps.toFixed(2) : '0', { kind: 'building', key, statKey: 'freezeDps' });
                addRow('Freeze Duration', Number.isFinite(freezeDuration) ? `${freezeDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'freezeDuration' });
            } else if (key === 'elements') {
                let burnDps = getBuildingStatForOwner(localPlayerId, key, level, 'burnDps');
                let poisonDps = getBuildingStatForOwner(localPlayerId, key, level, 'poisonDps');
                let freezeDps = getBuildingStatForOwner(localPlayerId, key, level, 'freezeDps');
                let burnDuration = getBuildingStatForOwner(localPlayerId, key, level, 'burnDuration');
                let poisonDuration = getBuildingStatForOwner(localPlayerId, key, level, 'poisonDuration');
                let freezeDuration = getBuildingStatForOwner(localPlayerId, key, level, 'freezeDuration');
                addRow('Burn DPS', Number.isFinite(burnDps) ? burnDps.toFixed(2) : '0', { kind: 'building', key, statKey: 'burnDps' });
                addRow('Poison DPS', Number.isFinite(poisonDps) ? poisonDps.toFixed(2) : '0', { kind: 'building', key, statKey: 'poisonDps' });
                addRow('Freeze DPS', Number.isFinite(freezeDps) ? freezeDps.toFixed(2) : '0', { kind: 'building', key, statKey: 'freezeDps' });
                addRow('Burn Duration', Number.isFinite(burnDuration) ? `${burnDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'burnDuration' });
                addRow('Poison Duration', Number.isFinite(poisonDuration) ? `${poisonDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'poisonDuration' });
                addRow('Freeze Duration', Number.isFinite(freezeDuration) ? `${freezeDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'freezeDuration' });
            }
        }
        if (key === 'water') {
            let wetDuration = getBuildingStatForOwner(localPlayerId, key, level, 'wetDuration');
            addRow('Wet Duration', Number.isFinite(wetDuration) ? `${wetDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'wetDuration' });
        } else if (key === 'sand_gun') {
            let sandDuration = getBuildingStatForOwner(localPlayerId, key, level, 'sandDuration');
            addRow('Slow Duration', Number.isFinite(sandDuration) ? `${sandDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'sandDuration' });
        } else if (key === 'watch_tower') {
            let watchDuration = getBuildingStatForOwner(localPlayerId, key, level, 'watchDuration');
            addRow('Watch Duration', Number.isFinite(watchDuration) ? `${watchDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'watchDuration' });
        }
    } else {
        let stats = calculateItemStats(key, level, localPlayerId);
        if (stats.maxEnergy > 0) addRow('Energy', `${fmt(stats.maxEnergy)}/${fmt(stats.maxEnergy)}`, { kind: 'building', key, statKey: 'maxEnergy' });
        if (key === 'farm') {
            let multiplier = Number.isFinite(stats.multiplier) ? stats.multiplier : level;
            addRow('Multiplier', `${multiplier.toFixed(2)}x gather`, { kind: 'building', key, statKey: 'multiplier' });
        }
        if (key === 'house') {
            let popCap = getBuildingStatForOwner(localPlayerId, key, level, 'popCap');
            if (!Number.isFinite(popCap)) popCap = getHousePopCapContribution(localPlayerId, level);
            addRow('Pop Cap', `+${fmt(Math.floor(popCap))}`, { kind: 'building', key, statKey: 'popCap' });
        }
        if (key === 'research') {
            let efficiency = getBuildingStatForOwner(localPlayerId, key, level, 'efficiency');
            if (Number.isFinite(efficiency)) {
                addRow('Efficiency', efficiency.toFixed(2), { kind: 'building', key, statKey: 'efficiency' });
            }
        }
        if (key === 'mine') {
            let blastDamage = getBuildingStatForOwner(localPlayerId, key, level, 'blastDamage');
            let blastRadius = getBuildingStatForOwner(localPlayerId, key, level, 'blastRadius');
            if (Number.isFinite(blastDamage) && blastDamage > 0) {
                addRow('Blast Damage', blastDamage.toFixed(2), { kind: 'building', key, statKey: 'blastDamage' });
            }
            if (Number.isFinite(blastRadius) && blastRadius > 0) {
                addRow('Blast Radius', `${blastRadius.toFixed(2)} tiles`, { kind: 'building', key, statKey: 'blastRadius' });
            }
        }
        if (key === 'lava' && stats.damage > 0) {
            let burnDps = getBuildingStatForOwner(localPlayerId, key, level, 'burnDps');
            let burnDuration = getBuildingStatForOwner(localPlayerId, key, level, 'burnDuration');
            addRow('Burn DPS', Number.isFinite(burnDps) ? burnDps.toFixed(2) : stats.damage.toFixed(2), { kind: 'building', key, statKey: 'burnDps' });
            addRow('Burn Duration', Number.isFinite(burnDuration) ? `${burnDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'burnDuration' });
        }
        if (key === 'poison_puddle' && stats.damage > 0) {
            let poisonDps = getBuildingStatForOwner(localPlayerId, key, level, 'poisonDps');
            let poisonDuration = getBuildingStatForOwner(localPlayerId, key, level, 'poisonDuration');
            addRow('Poison DPS', Number.isFinite(poisonDps) ? poisonDps.toFixed(2) : stats.damage.toFixed(2), { kind: 'building', key, statKey: 'poisonDps' });
            addRow('Poison Duration', Number.isFinite(poisonDuration) ? `${poisonDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'poisonDuration' });
        }
        if (key === 'ice_patch' && stats.damage > 0) {
            let freezeDps = getBuildingStatForOwner(localPlayerId, key, level, 'freezeDps');
            let freezeDuration = getBuildingStatForOwner(localPlayerId, key, level, 'freezeDuration');
            addRow('Freeze DPS', Number.isFinite(freezeDps) ? freezeDps.toFixed(2) : stats.damage.toFixed(2), { kind: 'building', key, statKey: 'freezeDps' });
            addRow('Freeze Duration', Number.isFinite(freezeDuration) ? `${freezeDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'freezeDuration' });
        }
        if (key === 'sand' && stats.damage > 0) addRow('Slow Power', stats.damage.toFixed(2));
        if (key === 'water_puddle') {
            let wetDuration = getBuildingStatForOwner(localPlayerId, key, level, 'wetDuration');
            addRow('Wet Duration', Number.isFinite(wetDuration) ? `${wetDuration.toFixed(1)}s` : '0.0s', { kind: 'building', key, statKey: 'wetDuration' });
        }
        if (key === 'area_upgrader') addRow('Effect', 'Area multiplier +1');
    }

    html += '</div>';
    return html;
}

function isBuildItemAvailable(key, playerId = localPlayerId) {
    if (key.startsWith('cloud_')) {
        return !towers.some(t => t.owner === playerId && t.type === key && t.energy > 0);
    }
    return true;
}

function getBuildMenuEnergyCost(key, purchaseCount) {
    let count = Math.max(1, Math.floor(purchaseCount || 1));
    if (key === 'area_upgrader') return Math.max(0, Math.floor(getAreaUpgradeCost(0) * count));
    let level = stackCountToLevel(count);
    let stats = calculateItemStats(key, level, localPlayerId);
    if (!stats || !Number.isFinite(stats.maxEnergy)) return 0;
    return Math.max(0, Math.floor(stats.maxEnergy));
}

function updateBuildMenu() {
    let container = document.getElementById('build-items');
    if (!container) return;
    let items = BUILD_CATEGORIES[activeBuildTab] || [];
    let cloudUnavailable = _computeCloudUnavailableSet(localPlayerId);
    let purchaseMultiplier = Math.max(1, Math.floor(buildPurchaseMultiplier || 1));

    _buildMenuNeedsRefresh = false;

    // Full rebuild only when tab changes
    if (_buildMenuTab !== activeBuildTab) {
        _buildMenuTab = activeBuildTab;
        _buildMenuItems = {};
        _buildMenuPriceSpans = {};
        container.innerHTML = '';
        for (let key of items) {
            let def = BASE_CARD_TYPES[key]; if (!def) continue;
            let div = document.createElement('div');
            div.className = 'build-item';
            div.dataset.key = key;
            let displayPrice = getBuildMenuEnergyCost(key, purchaseMultiplier);
            let available = key.startsWith('cloud_') ? !cloudUnavailable.has(key) : true;
            if (!available) div.classList.add('unavailable');
            if (selectedBuildItem === key) div.classList.add('selected');
            let thumbUrl = getItemThumbnail(key, 28);
            let iconWrap = document.createElement('span');
            iconWrap.className = 'bi-icon';
            let img = document.createElement('img');
            img.src = thumbUrl; img.width = 28; img.height = 28;
            iconWrap.appendChild(img);
            div.appendChild(iconWrap);
            let nameSpan = document.createElement('span');
            nameSpan.className = 'bi-name';
            nameSpan.textContent = def.name;
            div.appendChild(nameSpan);
            let priceSpan = document.createElement('span');
            priceSpan.className = 'bi-price';
            priceSpan.textContent = `⚡${formatBigNumber(displayPrice)}`;
            div.appendChild(priceSpan);
            bindInstantPress(div, () => {
                if (!isBuildItemAvailable(key)) return;
                selectedBuildItem = selectedBuildItem === key ? null : key;
                updateBuildMenu();
            });
            container.appendChild(div);
            _buildMenuItems[key] = div;
            _buildMenuPriceSpans[key] = priceSpan;
        }
    } else {
        // Stable update: just patch classes and prices
        _patchBuildMenuClasses(items, cloudUnavailable, purchaseMultiplier);
    }
    updateSelectedBuildDescription();
}

function _patchBuildMenuClasses(items, cloudUnavailable, purchaseMultiplier) {
    let list = items || BUILD_CATEGORIES[activeBuildTab] || [];
    let unavailableSet = cloudUnavailable || _computeCloudUnavailableSet(localPlayerId);
    let count = Math.max(1, Math.floor(purchaseMultiplier || buildPurchaseMultiplier || 1));
    for (let key of list) {
        let def = BASE_CARD_TYPES[key]; if (!def) continue;
        let div = _buildMenuItems[key]; if (!div) continue;
        let displayPrice = getBuildMenuEnergyCost(key, count);
        let available = key.startsWith('cloud_') ? !unavailableSet.has(key) : true;
        div.classList.remove('cant-afford');
        div.classList.toggle('unavailable', !available);
        if (!available && selectedBuildItem === key) selectedBuildItem = null;
        div.classList.toggle('selected', selectedBuildItem === key);
        let priceSpan = _buildMenuPriceSpans[key];
        if (priceSpan) priceSpan.textContent = `⚡${formatBigNumber(displayPrice)}`;
    }
}

function initBuildTabs() {
    document.querySelectorAll('.build-tab').forEach(tab => {
        bindInstantPress(tab, () => {
            document.querySelectorAll('.build-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeBuildTab = tab.dataset.tab;
            selectedBuildItem = null;
            updateBuildMenu();
        });
    });
}

function salvageBtn(gx, gy, isMarked, isUnit, unitId) {
    if (isUnit) {
        return `<div style="margin-top:3px;text-align:center"><span class="info-salvage-btn" data-unit-id="${unitId}" style="cursor:pointer;background:${isMarked ? '#533' : '#222'};padding:2px 8px;border:1px solid ${isMarked ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${isMarked ? '#f44' : '#888'}">${isMarked ? '\u2620\u2715' : '\u2620'}</span></div>`;
    }
    return `<div style="margin-top:3px;text-align:center"><span class="info-salvage-btn" data-gx="${gx}" data-gy="${gy}" style="cursor:pointer;background:${isMarked ? '#533' : '#222'};padding:2px 8px;border:1px solid ${isMarked ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${isMarked ? '#f44' : '#888'}">${isMarked ? '\u2620\u2715' : '\u2620'}</span></div>`;
}

function autoUpgradeBtn(gx, gy, enabled) {
    return `<span class="info-auto-upgrade-btn" data-gx="${gx}" data-gy="${gy}" data-enabled="${enabled ? '0' : '1'}" style="cursor:pointer;background:${enabled ? '#223' : '#222'};padding:2px 8px;border:1px solid ${enabled ? '#4af' : '#555'};border-radius:3px;font-size:9px;color:${enabled ? '#8cf' : '#888'}">L+${enabled ? 'ON' : 'OFF'}</span>`;
}

function autoResearchBtn(gx, gy, enabled) {
    return `<span class="info-auto-research-btn" data-gx="${gx}" data-gy="${gy}" data-enabled="${enabled ? '0' : '1'}" style="cursor:pointer;background:${enabled ? '#243025' : '#222'};padding:2px 8px;border:1px solid ${enabled ? '#6ccf7c' : '#555'};border-radius:3px;font-size:9px;color:${enabled ? '#9fdaab' : '#888'}">R ${enabled ? 'ON' : 'OFF'}</span>`;
}

function autoStackBtn(gx, gy, enabled) {
    return `<span class="info-auto-stack-btn" data-gx="${gx}" data-gy="${gy}" data-enabled="${enabled ? '0' : '1'}" style="cursor:pointer;background:${enabled ? '#2c261c' : '#222'};padding:2px 8px;border:1px solid ${enabled ? '#d9aa60' : '#555'};border-radius:3px;font-size:9px;color:${enabled ? '#ffd8a0' : '#888'}">\uD83E\uDDF1 ${enabled ? 'ON' : 'OFF'}</span>`;
}

function autoUpgradeGroupBtn(coordStr, allEnabled, anyEnabled) {
    let label = allEnabled ? 'ON' : (anyEnabled ? 'MIXED' : 'OFF');
    let nextAutoEnabled = allEnabled ? '0' : '1';
    return `<span class="info-auto-upgrade-group-btn" data-coords="${coordStr}" data-enabled="${nextAutoEnabled}" style="cursor:pointer;background:${allEnabled ? '#223' : '#222'};padding:2px 8px;border:1px solid ${allEnabled ? '#4af' : '#555'};border-radius:3px;font-size:9px;color:${allEnabled ? '#8cf' : '#888'}">L+${label}</span>`;
}

function autoResearchGroupBtn(coordStr, allEnabled, anyEnabled) {
    let label = allEnabled ? 'ON' : (anyEnabled ? 'MIXED' : 'OFF');
    let nextEnabled = allEnabled ? '0' : '1';
    return `<span class="info-auto-research-group-btn" data-coords="${coordStr}" data-enabled="${nextEnabled}" style="cursor:pointer;background:${allEnabled ? '#243025' : '#222'};padding:2px 8px;border:1px solid ${allEnabled ? '#6ccf7c' : '#555'};border-radius:3px;font-size:9px;color:${allEnabled ? '#9fdaab' : '#888'}">R ${label}</span>`;
}

function autoStackGroupBtn(coordStr, allEnabled, anyEnabled) {
    let label = allEnabled ? 'ON' : (anyEnabled ? 'MIXED' : 'OFF');
    let nextEnabled = allEnabled ? '0' : '1';
    return `<span class="info-auto-stack-group-btn" data-coords="${coordStr}" data-enabled="${nextEnabled}" style="cursor:pointer;background:${allEnabled ? '#2c261c' : '#222'};padding:2px 8px;border:1px solid ${allEnabled ? '#d9aa60' : '#555'};border-radius:3px;font-size:9px;color:${allEnabled ? '#ffd8a0' : '#888'}">\uD83E\uDDF1 ${label}</span>`;
}

function buildToggleBtn(gx, gy, enabled) {
    return `<span class="info-build-toggle-btn" data-gx="${gx}" data-gy="${gy}" data-enabled="${enabled ? '0' : '1'}" style="cursor:pointer;background:${enabled ? '#232' : '#222'};padding:2px 8px;border:1px solid ${enabled ? '#6f6' : '#555'};border-radius:3px;font-size:9px;color:${enabled ? '#9f9' : '#888'}">\uD83D\uDD28 ${enabled ? 'ON' : 'OFF'}</span>`;
}

function buildToggleGroupBtn(coordStr, allEnabled, anyEnabled) {
    let label = allEnabled ? 'ON' : (anyEnabled ? 'MIXED' : 'OFF');
    let nextEnabled = allEnabled ? '0' : '1';
    return `<span class="info-build-toggle-group-btn" data-coords="${coordStr}" data-enabled="${nextEnabled}" style="cursor:pointer;background:${allEnabled ? '#232' : '#222'};padding:2px 8px;border:1px solid ${allEnabled ? '#6f6' : '#555'};border-radius:3px;font-size:9px;color:${allEnabled ? '#9f9' : '#888'}">\uD83D\uDD28 ${label}</span>`;
}

function queueToggleBtn(gx, gy, enabled) {
    return `<span class="info-queue-toggle-btn" data-gx="${gx}" data-gy="${gy}" data-enabled="${enabled ? '0' : '1'}" style="cursor:pointer;background:${enabled ? '#222c34' : '#222'};padding:2px 8px;border:1px solid ${enabled ? '#6cb7ff' : '#555'};border-radius:3px;font-size:9px;color:${enabled ? '#a7d6ff' : '#888'}">Q ${enabled ? 'ON' : 'OFF'}</span>`;
}

function queueToggleGroupBtn(coordStr, allEnabled, anyEnabled) {
    let label = allEnabled ? 'ON' : (anyEnabled ? 'MIXED' : 'OFF');
    let nextEnabled = allEnabled ? '0' : '1';
    return `<span class="info-queue-toggle-group-btn" data-coords="${coordStr}" data-enabled="${nextEnabled}" style="cursor:pointer;background:${allEnabled ? '#222c34' : '#222'};padding:2px 8px;border:1px solid ${allEnabled ? '#6cb7ff' : '#555'};border-radius:3px;font-size:9px;color:${allEnabled ? '#a7d6ff' : '#888'}">Q ${label}</span>`;
}

function disabledInfoPill(label) {
    return `<span style="cursor:default;background:#1a1a1a;padding:2px 8px;border:1px solid #333;border-radius:3px;font-size:9px;color:#555;">${label}</span>`;
}

function formatInfoCurrency(n, d = 0) {
    return `⚡${formatBigNumber(n, d)}`;
}

function formatInfoFraction(a, b, d = 0) {
    return `${formatBigNumber(a, d)}/${formatBigNumber(b, d)}`;
}

function formatInfoRowValue(value) {
    return (typeof value === 'number' && Number.isFinite(value)) ? formatBigNumber(value) : value;
}

function formatStatLabelWithResearchLevel(playerId, kind, key, statKey, label, showPlaceholder = true) {
    let lvlText = '';
    let lvlColor = '#666';
    if (kind && key && statKey && getResearchStatEntry(kind, key, statKey)) {
        let statLvl = getPlayerResearchLevel(playerId, kind, key, statKey);
        lvlText = `L${statLvl}`;
        lvlColor = '#9cf';
    }
    let badge = showPlaceholder
        ? `<span style="display:inline-block;min-width:26px;color:${lvlColor};font-size:10px">${lvlText}</span>`
        : (lvlText ? `<span style="color:${lvlColor};font-size:10px">${lvlText}</span> ` : '');
    return `${badge}${label}`;
}

function infoRow(label, value, effValue, matrixOpts = null) {
    let labelHtml = String(label === undefined || label === null ? '' : label);
    if (!labelHtml.includes('info-stat-matrix-btn')) {
        let opts = matrixOpts || deriveInfoPanelMatrixOptsFromLabel(labelHtml);
        if (opts) labelHtml = withInfoPanelStatMatrixButton(labelHtml, opts);
    }
    if (effValue !== undefined) {
        return `<div class="info-row"><span class="info-label">${labelHtml}</span><span class="info-base">${formatInfoRowValue(value)}</span><span class="info-eff">${formatInfoRowValue(effValue)}</span></div>`;
    }
    return `<div class="info-row"><span class="info-label">${labelHtml}</span><span class="info-value">${formatInfoRowValue(value)}</span></div>`;
}

function registerInfoPanelStatMatrixDescriptor(label, opts = {}) {
    let id = nextInfoPanelStatMatrixDescriptorId++;
    infoPanelStatMatrixDescriptorById[id] = {
        title: String(opts.title || label || 'Stat'),
        kind: opts.kind || '',
        key: opts.key || '',
        statKey: opts.statKey || '',
        fixedValue: opts.fixedValue,
        getValue: (typeof opts.getValue === 'function') ? opts.getValue : null,
    };
    return id;
}

function withInfoPanelStatMatrixButton(label, opts = null) {
    if (!opts) return label;
    let id = registerInfoPanelStatMatrixDescriptor(label, opts);
    return `<span style="display:inline-flex;align-items:center;gap:4px;"><button type="button" class="info-stat-matrix-btn" data-matrix-id="${id}" title="Open level/research matrix" style="cursor:pointer;background:#1a2631;color:#cfe6ff;border:1px solid #486179;border-radius:3px;font-size:10px;padding:0 4px;line-height:1.2">M</button><span>${label}</span></span>`;
}

function runWithInfoPanelStatMatrixContext(ctx, fn) {
    let prev = activeInfoPanelStatMatrixContext;
    activeInfoPanelStatMatrixContext = ctx || null;
    try {
        return fn();
    } finally {
        activeInfoPanelStatMatrixContext = prev;
    }
}

function getInfoPanelWorkerUnitTypeForSpawnerType(type) {
    if (type === 'spawner') return 'collector';
    if (type === 'astar_spawner') return 'astar_collector';
    if (type === 'salvager') return 'salvager_unit';
    if (type === 'builder_spawner') return 'builder_unit';
    if (type === 'healer_spawner') return 'healer_unit';
    if (type === 'research') return 'researcher_unit';
    return '';
}

function getInfoPanelMatrixContextForEntity(e) {
    if (!e) return null;
    if (e.type === 'barrack' && e.unitType) {
        return { kind: 'building', key: `barrack_${e.unitType}`, unitType: e.unitType };
    }
    if (e.type === 'spawner' || e.type === 'astar_spawner' || e.type === 'salvager' || e.type === 'builder_spawner' || e.type === 'healer_spawner' || e.type === 'research') {
        return { kind: 'building', key: e.type, unitType: getInfoPanelWorkerUnitTypeForSpawnerType(e.type) };
    }
    if (e.type && BASE_CARD_TYPES[e.type]) {
        return { kind: 'building', key: e.type };
    }
    return null;
}

function getInfoPanelMatrixContextForUnit(u) {
    if (!u) return null;
    return { kind: 'unit', key: u.unitType || 'norm', unitType: u.unitType || 'norm' };
}

function deriveInfoPanelMatrixOptsFromLabel(label) {
    let ctx = activeInfoPanelStatMatrixContext;
    if (!ctx || !ctx.kind || !ctx.key) return null;

    let text = String(label === undefined || label === null ? '' : label);
    let plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!plain) return null;

    let kind = ctx.kind;
    let key = ctx.key;
    let unitType = ctx.unitType || (kind === 'unit' ? key : '');
    let statKey = '';
    let customGetValue = null;

    if (plain.startsWith('unit energy')) {
        kind = 'unit'; key = unitType || key; statKey = 'energy';
    } else if (plain.startsWith('unit atk') || plain === 'attack') {
        if (plain.startsWith('unit atk') || kind === 'unit') {
            kind = 'unit'; key = unitType || key; statKey = 'atk';
        } else {
            statKey = 'damage';
        }
    } else if (plain.startsWith('unit range')) {
        kind = 'unit'; key = unitType || key; statKey = 'attackRange';
    } else if (plain.startsWith('unit spd') || plain === 'speed') {
        kind = 'unit'; key = unitType || key; statKey = 'speed';
    } else if (plain === 'energy') {
        statKey = kind === 'unit' ? 'energy' : 'maxEnergy';
    } else if (plain === 'range') {
        statKey = kind === 'unit' ? 'attackRange' : 'visionRange';
    } else if (plain === 'visibility') {
        statKey = 'visionRange';
    } else if (plain === 'damage') {
        statKey = 'damage';
    } else if (plain === 'cooldown') {
        statKey = kind === 'unit' ? 'atkCd' : 'cd';
    } else if (plain === 'dps') {
        customGetValue = (thingLevel, researchLevel) => {
            let tl = Math.max(1, clampThingLevel(thingLevel));
            let rl = Math.max(0, clampResearchLevel(researchLevel));
            if (kind === 'unit') {
                let atk = getUnitStatFromMap(key, tl, 'atk', rl);
                let cd = getUnitStatFromMap(key, tl, 'atkCd', rl);
                if (!Number.isFinite(atk) || !Number.isFinite(cd) || cd <= 0) return '0';
                return formatBigNumber(atk / cd * TICK_RATE, 1);
            }
            if (key === 'laser') {
                let dmg = getBuildingStatFromMap(key, tl, 'damage', rl);
                if (!Number.isFinite(dmg)) return '0';
                return formatBigNumber(dmg / 60 * TICK_RATE, 1);
            }
            let dmg = getBuildingStatFromMap(key, tl, 'damage', rl);
            let cd = getBuildingStatFromMap(key, tl, 'cd', rl);
            if (!Number.isFinite(dmg) || !Number.isFinite(cd) || cd <= 0) return '0';
            return formatBigNumber(dmg / cd, 1);
        };
    } else if (plain === 'build speed') {
        kind = 'unit'; key = unitType || key; statKey = 'builderDps';
    } else if (plain === 'heal speed') {
        kind = 'unit'; key = unitType || key; statKey = 'healerDps';
    } else if (plain === 'research speed') {
        kind = 'unit'; key = unitType || key; statKey = 'researcherDps';
    } else if (plain === 'gather speed') {
        kind = 'unit'; key = unitType || key; statKey = 'gatherPerTrip';
    } else if (plain === 'transfer cd') {
        kind = 'unit'; key = unitType || key; statKey = 'transferCooldown';
    } else if (plain === 'burn dps') {
        statKey = 'burnDps';
    } else if (plain === 'burn duration') {
        statKey = 'burnDuration';
    } else if (plain === 'poison dps') {
        statKey = 'poisonDps';
    } else if (plain === 'poison duration') {
        statKey = 'poisonDuration';
    } else if (plain === 'freeze dps') {
        statKey = 'freezeDps';
    } else if (plain === 'freeze duration') {
        statKey = 'freezeDuration';
    } else if (plain === 'wet duration') {
        statKey = 'wetDuration';
    } else if (plain === 'slow duration') {
        statKey = 'sandDuration';
    } else if (plain === 'watch duration') {
        statKey = 'watchDuration';
    } else if (plain === 'multiplier') {
        statKey = 'multiplier';
    } else if (plain === 'pop cap') {
        statKey = 'popCap';
    } else {
        return null;
    }

    if (customGetValue) {
        return {
            title: `${key} / ${plain}`,
            getValue: customGetValue
        };
    }
    return {
        title: `${key} / ${plain}`,
        kind,
        key,
        statKey
    };
}

function getInfoPanelLevelMatrixEnergyText(obj, thingLevel, researchLevel) {
    let tl = Math.max(1, clampThingLevel(thingLevel));
    let rl = Math.max(0, clampResearchLevel(researchLevel));

    let toEnergyText = (v) => {
        if (!Number.isFinite(v)) return null;
        return `⚡${formatBigNumber(Math.max(0, Math.round(v)))}`;
    };

    if (!obj) return `L${tl}`;

    if (obj.unitType && (obj.id !== undefined || obj.commandState !== undefined)) {
        let energy = getUnitStatFromMap(obj.unitType, tl, 'energy', rl);
        return toEnergyText(energy) || `L${tl}`;
    }

    let buildingKey = null;
    if (obj.type === 'barrack') buildingKey = `barrack_${obj.unitType || 'norm'}`;
    else if (obj.type) buildingKey = obj.type;

    if (buildingKey) {
        let energy = getBuildingStatFromMap(buildingKey, tl, 'maxEnergy', rl);
        return toEnergyText(energy) || `L${tl}`;
    }

    return `L${tl}`;
}

function bindInfoPanelInteractionTracking(panel) {
    if (!panel) return;
    if (!infoPanelGlobalMouseTrackingBound) {
        infoPanelGlobalMouseTrackingBound = true;
        document.addEventListener('mousemove', (ev) => {
            uiMouseClientX = ev.clientX;
            uiMouseClientY = ev.clientY;
        }, { passive: true });
    }
    if (infoPanelInteractionTrackingBoundByEl.has(panel)) return;
    infoPanelInteractionTrackingBoundByEl.add(panel);

    let markManualScroll = () => {
        infoPanelLastManualScrollTsByEl.set(panel, performance.now());
    };
    let markManualInteraction = () => {
        infoPanelManualScrollInteractionUntilByEl.set(panel, performance.now() + 1200);
    };

    panel.addEventListener('wheel', () => {
        markManualInteraction();
        markManualScroll();
    }, { passive: true });
    panel.addEventListener('touchstart', markManualInteraction, { passive: true });
    panel.addEventListener('touchmove', () => {
        markManualInteraction();
        markManualScroll();
    }, { passive: true });
    panel.addEventListener('pointerdown', (ev) => {
        if (!ev) return;
        if (ev.pointerType && ev.pointerType !== 'mouse') {
            markManualInteraction();
            return;
        }

        let rect = panel.getBoundingClientRect();
        let vScrollbar = Math.max(0, panel.offsetWidth - panel.clientWidth);
        let hScrollbar = Math.max(0, panel.offsetHeight - panel.clientHeight);
        let onVScrollbar = vScrollbar > 0
            && ev.clientX >= (rect.right - vScrollbar - 2)
            && ev.clientX <= (rect.right + 2)
            && ev.clientY >= rect.top
            && ev.clientY <= rect.bottom;
        let onHScrollbar = hScrollbar > 0
            && ev.clientY >= (rect.bottom - hScrollbar - 2)
            && ev.clientY <= (rect.bottom + 2)
            && ev.clientX >= rect.left
            && ev.clientX <= rect.right;

        if (onVScrollbar || onHScrollbar) {
            markManualInteraction();
        }
    }, { passive: true });
    panel.addEventListener('scroll', (ev) => {
        let now = performance.now();
        let programmaticUntil = infoPanelProgrammaticScrollUntilByEl.get(panel) || 0;
        if (now <= programmaticUntil) return;
        let until = infoPanelManualScrollInteractionUntilByEl.get(panel) || 0;
        if (now <= until) markManualScroll();
    }, { passive: true });
}

function getInfoPanelAnchorKey(el) {
    if (!el) return '';
    let cls = String(el.className || '').trim();
    let ds = el.dataset || {};
    let keyParts = [
        el.tagName || '',
        cls,
        ds.type || '',
        ds.kind || '',
        ds.key || '',
        ds.statKey || '',
        ds.gx || '',
        ds.gy || '',
        ds.coords || '',
        ds.scope || '',
        ds.thingId || '',
        ds.unitId || '',
        ds.matrixId || ''
    ];
    let text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    keyParts.push(text);
    return keyParts.join('|');
}

function captureInfoPanelMouseAnchor(panel) {
    if (!panel) return null;
    let lastManualTs = infoPanelLastManualScrollTsByEl.get(panel) || 0;
    if (performance.now() - lastManualTs < 250) return null;

    let rect = panel.getBoundingClientRect();
    let mx = uiMouseClientX;
    let my = uiMouseClientY;
    let mouseInside = Number.isFinite(mx) && Number.isFinite(my)
        && mx >= rect.left && mx <= rect.right && my >= rect.top && my <= rect.bottom;
    if (!mouseInside) {
        mx = rect.left + rect.width / 2;
        my = rect.top + rect.height / 2;
    }

    let rawEl = document.elementFromPoint(mx, my);
    if (!rawEl || !panel.contains(rawEl)) {
        let list = document.elementsFromPoint(mx, my);
        rawEl = Array.isArray(list) ? (list.find(el => panel.contains(el)) || null) : null;
    }
    if (!rawEl) rawEl = panel.firstElementChild || panel;

    let anchorEl = rawEl.closest('[data-kind],[data-key],[data-stat-key],[data-gx],[data-gy],[data-coords],[data-scope],[data-thing-id],[data-unit-id],[data-matrix-id],button,.info-row,.info-title');
    if (!anchorEl || !panel.contains(anchorEl)) anchorEl = rawEl;

    let anchorRect = anchorEl.getBoundingClientRect();
    return {
        key: getInfoPanelAnchorKey(anchorEl),
        mouseX: mx,
        mouseY: my,
        offsetX: mx - anchorRect.left,
        offsetY: my - anchorRect.top
    };
}

function restoreInfoPanelMouseAnchor(panel, anchor) {
    if (!panel || !anchor || !anchor.key) return;
    let lastManualTs = infoPanelLastManualScrollTsByEl.get(panel) || 0;
    if (performance.now() - lastManualTs < 250) return;

    let candidates = panel.querySelectorAll('*');
    let best = null;
    let bestScore = Infinity;
    let desiredTop = anchor.mouseY - anchor.offsetY;
    let desiredLeft = anchor.mouseX - anchor.offsetX;

    for (let el of candidates) {
        if (getInfoPanelAnchorKey(el) !== anchor.key) continue;
        let top = el.getBoundingClientRect().top;
        let score = Math.abs(top - desiredTop);
        if (score < bestScore) {
            bestScore = score;
            best = el;
        }
    }

    if (!best) return;
    let afterRect = best.getBoundingClientRect();
    let deltaY = afterRect.top - desiredTop;
    let deltaX = afterRect.left - desiredLeft;
    infoPanelProgrammaticScrollUntilByEl.set(panel, performance.now() + 80);
    if (Math.abs(deltaY) > 0.5) panel.scrollTop += deltaY;
    if (Math.abs(deltaX) > 0.5) panel.scrollLeft += deltaX;
}

function getSpawnerEnergyProgress(spawner) {
    if (!spawner || !Array.isArray(spawner.spawnQueue) || spawner.spawnQueue.length <= 0) {
        return { paid: 0, required: 0, left: 0, pct: 0, hasQueue: false };
    }
    let owner = Number.isFinite(spawner.owner) ? spawner.owner : localPlayerId;
    let effLvl = getThingEffectiveLevel(spawner);
    let fallbackType = getSpawnerFallbackUnitType(spawner);
    let front = getQueuedSpawnInfo(spawner.spawnQueue[0], fallbackType, effLvl, owner);
    let required = Math.max(1, Math.floor(Number(front.energyRequired) || 1));
    let paid = Math.max(0, Math.min(required, Math.floor(Number(front.energyPaid) || 0)));
    let left = Math.max(0, required - paid);
    let pct = required > 0 ? (paid / required) : 0;
    return { paid, required, left, pct, hasQueue: true };
}

function getSpawnerGroupEnergyProgress(spawnerGroup) {
    if (!Array.isArray(spawnerGroup) || spawnerGroup.length <= 0) {
        return { paid: 0, required: 0, left: 0, pct: 0, hasQueue: false };
    }
    let paid = 0;
    let required = 0;
    let hasQueue = false;
    for (let s of spawnerGroup) {
        let p = getSpawnerEnergyProgress(s);
        if (!p.hasQueue) continue;
        hasQueue = true;
        paid += p.paid;
        required += p.required;
    }
    let left = Math.max(0, required - paid);
    let pct = required > 0 ? (paid / required) : 0;
    return { paid, required, left, pct, hasQueue };
}

function renderSpawnerEnergyProgressRow(progress, label = 'Spawn Progress') {
    let p = progress || { paid: 0, required: 0, left: 0, pct: 0, hasQueue: false };
    let barPct = Math.max(0, Math.min(1, Number(p.pct) || 0));
    let rightText = p.hasQueue
        ? `${formatInfoCurrency(p.paid)}/${formatInfoCurrency(p.required)}`
        : `${formatInfoCurrency(0)}/${formatInfoCurrency(0)}`;

    let html = '';
    html += `<div class="info-row" style="padding-top:0;">`;
    html += `<div style="position:relative;width:100%;height:12px;border:1px solid #35516a;border-radius:3px;background:#0f161c;overflow:hidden;">`;
    html += `<div style="position:absolute;left:0;top:0;bottom:0;width:${(barPct * 100).toFixed(1)}%;background:linear-gradient(90deg,#2d7dd2,#49c0ff);"></div>`;
    html += `<div style="position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#d6ecff;font-size:9px;font-weight:700;text-shadow:0 1px 1px #000;">${rightText}</div>`;
    html += `</div>`;
    html += `</div>`;
    return html;
}

function renderResearchWorkProgressRow(workDone, workRequired) {
    let required = Math.max(0, Number(workRequired) || 0);
    let done = Math.max(0, Math.min(required, Number(workDone) || 0));
    let pct = required > 0 ? (done / required) : 0;
    let barPct = Math.max(0, Math.min(1, pct));
    let text = `${formatInfoCurrency(done)}/${formatInfoCurrency(required)}`;

    let html = '';
    html += `<div class="info-row" style="padding-top:2px;">`;
    html += `<div style="position:relative;width:100%;height:12px;border:1px solid #35516a;border-radius:3px;background:#0f161c;overflow:hidden;">`;
    html += `<div style="position:absolute;left:0;top:0;bottom:0;width:${(barPct * 100).toFixed(1)}%;background:linear-gradient(90deg,#2d7dd2,#49c0ff);"></div>`;
    html += `<div style="position:absolute;left:0;right:0;top:0;bottom:0;display:flex;align-items:center;justify-content:center;color:#d6ecff;font-size:9px;font-weight:700;text-shadow:0 1px 1px #000;">${text}</div>`;
    html += `</div>`;
    html += `</div>`;
    return html;
}

function getLevelHtml(obj) {
    let actualLvl = stackCountToLevel(obj.stacks || 1);
    if (obj.underConstruction) actualLvl = 0;
    let effLvl = getDisplayLevel(obj);
    let potLvl = obj.underConstruction
        ? Math.max(0, Math.floor(Number(obj.potentialEffectiveLevel || effLvl || actualLvl) || 0))
        : getThingPotentialLevel(obj, Math.max(1, effLvl || actualLvl));
    let manualLvl = obj.underConstruction
        ? actualLvl
        : stackCountToLevel(getThingManualStacks(obj));
    potLvl = Math.max(potLvl, manualLvl);

    let html = `<span style="color:#888">L${actualLvl}</span>`;
    if (effLvl !== actualLvl && effLvl > 0) {
        html += ` <span style="color:#4f4">L${effLvl}</span>`;
    }
    if (potLvl > Math.max(actualLvl, effLvl)) {
        let arrowFrom = (effLvl !== actualLvl && effLvl > 0) ? effLvl : actualLvl;
        if (arrowFrom > 0) {
            html += `<span style="color:#aaa">-></span><span style="color:#f44">L${potLvl}</span>`;
        }
    }
    return html;
}

function infoRowLevel(label, obj) {
    let valueHtml = getLevelHtml(obj);
    let matrixLabel = withInfoPanelStatMatrixButton(label, {
        title: `${obj && (obj.type || obj.unitType || 'Thing')} / Level`,
        getValue: (thingLevel, researchLevel) => getInfoPanelLevelMatrixEnergyText(obj, thingLevel, researchLevel)
    });
    return `<div class="info-row"><span class="info-label">${matrixLabel}</span><span class="info-value" style="text-align:right" class="level-display">${valueHtml}</span></div>`;
}

function infoHeader(name, obj, opts = null) {
    let groupSize = obj.effectiveGroupSize || 1;
    let baseStacks = obj.stacks || 1;
    let effStacks = obj.effectiveStacks || baseStacks;
    // Find area info - support both gx/gy and _gx/_gy (floor items use _gx/_gy)
    let areaSize = 0, areaLevel = 0;
    let gx = obj.gx !== undefined ? obj.gx : obj._gx;
    let gy = obj.gy !== undefined ? obj.gy : obj._gy;
    if (gx !== undefined && gy !== undefined && gy >= 0 && gy < GRID_H && gx >= 0 && gx < GRID_W) {
        let aId = grid[gy][gx].areaId;
        if (aId !== -1) {
            let area = getAreaById(aId);
            if (area) { areaSize = area.cells.length; areaLevel = area.multiplierLevel || 0; }
        }
    }
    let areaLevelColor = AREA_LEVEL_COLORS[areaLevel] || '#888';
    let leftBtn = (opts && opts.leftButtonHtml) ? opts.leftButtonHtml : '';
    let html = `<div class="info-title">${leftBtn}${name} `;
    if (opts && opts.mixedLevel) html += `<span style="color:#fc8">Mixed</span> `;
    else html += getLevelHtml(obj) + ` `;
    if (groupSize > 1) html += `<span style="color:#4af;font-size:10px">G${groupSize}</span> `;
    if (areaSize > 0) html += `<span style="color:#fd0;font-size:10px">A${areaSize}</span> `;
    html += `<span style="color:${areaLevelColor};font-size:10px">M${areaLevel}</span>`;
    if (effStacks !== baseStacks) html += ` <span style="color:#4f4;font-size:10px">S${effStacks}</span>`;
    html += `</div>`;
    return html;
}

function infoHeaderUnit(name, u, opts = null) {
    let lvl = Math.max(1, Math.floor(u.unitLevel || 1));
    let effLvl = Math.max(1, Math.floor(u.effectiveLevel || lvl));
    let leftBtn = (opts && opts.leftButtonHtml) ? opts.leftButtonHtml : '';
    let html = `<div class="info-title">${leftBtn}${name} `;
    if (opts && opts.mixedLevel) html += `<span style="color:#fc8">Mixed</span>`;
    else html += `<span style="color:#888">L${lvl}</span>`;
    if (!(opts && opts.mixedLevel) && effLvl !== lvl) html += ` <span style="color:#4f4">L${effLvl}</span>`;
    html += `</div>`;
    return html;
}

function infoDesc(text) {
    return `<div style="font-size:9px;color:#777;margin-top:4px;border-top:1px solid #333;padding-top:3px;font-style:italic">${text}</div>`;
}

// Returns units filtered by active sub-group toggles
function getUnitGroupKey(u) {
    if (!u) return 'unit_unknown';
    return ignoreLevelSubgroups
        ? ('unit_' + u.unitType)
        : ('unit_' + u.unitType + '_L' + (u.unitLevel || 1));
}

function getActiveUnits() {
    if (selectedUnits.length === 0) return [];
    return selectedUnits.filter(u => !u.dead && activeSubGroups[getUnitGroupKey(u)] !== false);
}

// Returns selected entities filtered by active sub-group toggles
function getActiveEntities() {
    if (selectedEntities.length === 0) return [];
    return selectedEntities.filter(e => {
        if (e.energy !== undefined && e.energy <= 0) return false;
        return activeSubGroups[getEntityGroupKey(e)] !== false;
    });
}

function getEntityGroupKey(e) {
    if (e._isGoldMine) return 'goldmine';
    if (e._isAstarMine) return 'astarmine';
    if (ignoreLevelSubgroups) {
        if (e.type === 'barrack') return 'barrack_' + e.unitType;
        if (e instanceof Tower) return 'tower_' + e.type;
        if (e.type === 'spawner' || e.type === 'astar_spawner' || e.type === 'salvager' || e.type === 'builder_spawner' || e.type === 'healer_spawner' || e.type === 'research') return e.type;
        if (e.type && BASE_CARD_TYPES[e.type]) return 'floor_' + e.type;
        return 'unknown_type';
    }
    let state = e.underConstruction ? 'build' : (e.isUpgrading ? 'upg' : (e.isStacking ? 'stack' : 'ready'));
    let lvl = getDisplayLevel(e);
    let lvlPart = '_L' + lvl;
    if (e.type === 'barrack') return 'barrack_' + e.unitType + lvlPart + '_' + state;
    if (e instanceof Tower) return 'tower_' + e.type + lvlPart + '_' + state;
    if (e.type === 'spawner' || e.type === 'astar_spawner' || e.type === 'salvager' || e.type === 'builder_spawner' || e.type === 'healer_spawner' || e.type === 'research') return e.type + lvlPart + '_' + state;
    if (e.type && BASE_CARD_TYPES[e.type]) return 'floor_' + e.type + lvlPart + '_' + state;
    return 'unknown_' + Math.random();
}

function getEntityGroupLabel(e) {
    if (e._isGoldMine) return 'Energy Mine';
    if (e._isAstarMine) return 'A* Mine';
    if (e.type === 'barrack') return ((BASE_CARD_TYPES['barrack_' + e.unitType] || {}).name || e.unitType);
    if (e instanceof Tower) return (BASE_CARD_TYPES[e.type] || {}).name || e.type;
    if (e.type === 'spawner') return 'Collector';
    if (e.type === 'astar_spawner') return 'A*er';
    if (e.type === 'salvager') return 'Salvager';
    if (e.type === 'builder_spawner') return 'Builder';
    if (e.type === 'healer_spawner') return 'Healer';
    if (e.type === 'research') return 'Research';
    if (e.type && BASE_CARD_TYPES[e.type]) return BASE_CARD_TYPES[e.type].name;
    return 'Unknown';
}

function getGroupThumbKey(grp) {
    let e = grp.items[0];
    if (grp.isUnit) return e.unitType;
    if (e._isGoldMine) return 'goldmine';
    if (e._isAstarMine) return 'astarmine';
    if (e.type === 'barrack') return 'barrack_' + e.unitType;
    if (e instanceof Tower) return e.type;
    if (e.type === 'spawner' || e.type === 'astar_spawner' || e.type === 'salvager' || e.type === 'builder_spawner' || e.type === 'healer_spawner' || e.type === 'research') return e.type;
    if (e.type && BASE_CARD_TYPES[e.type]) return e.type;
    return null;
}

function getGroupBorderColor(grp) {
    let e = grp.items[0];
    if (grp.isUnit) return (BASE_UNIT_STATS[e.unitType] || {}).color || '#fff';
    if (e._isGoldMine) return '#fd0';
    if (e._isAstarMine) return '#bbb';
    if (e.type === 'barrack') return (BASE_UNIT_STATS[e.unitType] || {}).color || '#686';
    if (e instanceof Tower) return (BASE_CARD_TYPES[e.type] || {}).color || '#fff';
    let ct = BASE_CARD_TYPES[e.type] || {};
    return ct.color || '#fff';
}

function getGroupLevel(key, grp) {
    if (ignoreLevelSubgroups) return null;
    let e = grp.items[0];
    if (grp.isUnit) return getUnitBaseLevel(e);
    if (e._isGoldMine) return null;
    if (e._isAstarMine) return null;
    if (e.underConstruction) return 0;
    if (e.effectiveLevel !== undefined) return getThingEffectiveLevel(e);
    if (e.level !== undefined || e.stacks) return getThingBaseLevel(e);
    return null;
}

function getEntityLevelToken(e) {
    if (!e || e._isGoldMine || e._isAstarMine) return null;
    if (e.underConstruction) return 'build';
    if (e.isUpgrading) return 'upg';
    if (e.isStacking) return 'stack';
    if (e.effectiveLevel !== undefined) return `L${getThingEffectiveLevel(e)}`;
    if (e.level !== undefined || e.stacks !== undefined) return `L${getThingBaseLevel(e)}`;
    return null;
}

function getEntityEnergyDisplayMax(e) {
    if (!e) return 1;
    let currentMax = Math.max(1, Math.floor(e.maxEnergy || 1));
    let effectiveLevel = getThingEffectiveLevel(e);
    let potentialLevel = getThingPotentialLevel(e, effectiveLevel);

    let canUpgrade = potentialLevel > effectiveLevel;
    if (!canUpgrade) return currentMax;
    let nextMax = Math.max(1, Math.floor(getUpgrademaxEnergy(e, effectiveLevel + 1) || currentMax));
    return Math.max(currentMax, nextMax);
}

function getEntityStatusText(e, includeResearch = false) {
    if (!e) return '';
    if (e.underConstruction) return '\uD83D\uDD28 Under Construction';
    if (includeResearch && e.isResearching) return '\uD83E\uDDEA Researching';
    if (e.isUpgrading) return '\u2B06\uFE0F Upgrading';
    if (e.isStacking) {
        let remainingEnergy = getThingStackingRemainingEnergy(e);
        return `\uD83E\uDDF1 Stacking (${formatBigNumber(remainingEnergy, 1)})`;
    }
    return '\u2713 Ready';
}

function getStackProgressText(stackedStacks, manualStacks) {
    let stacked = Math.max(1, Math.floor(Number(stackedStacks) || 1));
    let manual = Math.max(stacked, Math.floor(Number(manualStacks) || stacked));
    return `${formatBigNumber(stacked)}/${formatBigNumber(manual)}`;
}

function infoRowStacks(baseStacks, baseLevel, effStacks, effLevel, manualStacks = baseStacks) {
    let baseText = getStackProgressText(baseStacks, manualStacks);
    let hasEff = Number.isFinite(effStacks) && Number.isFinite(effLevel);
    let matrixOpts = {
        title: 'Stacks',
        getValue: (thingLevel) => `x${getRequiredStacksForLevel(Math.max(1, Math.floor(Number(thingLevel) || 1)))}`
    };
    if (!hasEff) return infoRow('Stacks', baseText, undefined, matrixOpts);
    let effText = getStackProgressText(effStacks, manualStacks);
    return infoRow('Stacks', baseText, effText, matrixOpts);
}

function renderBarrackInfo(e) {
    let html = '';
    let bKey = 'barrack_' + e.unitType;
    let uLvl = getThingEffectiveLevel(e);
    let uEnergy = getUnitStatForOwner(e.owner, e.unitType, uLvl, 'energy');
    let uAtk = getUnitStatForOwner(e.owner, e.unitType, uLvl, 'atk');
    let uRange = getUnitStatForOwner(e.owner, e.unitType, uLvl, 'attackRange');
    let uSpeed = getUnitStatForOwner(e.owner, e.unitType, uLvl, 'speed');
    let upg = getNextLevelUpgradeInfo(e);
    let baseVisTiles = getEntityBaseVisibilityRangeTiles(e);
    let effVisTiles = getEntityEffectiveVisibilityRangeTiles(e);
    let baseMaxEnergy = getEntityBaseEnergyMax(e);
    let effMaxEnergy = getEntityEffectiveEnergyMax(e);
    html += infoRow('Energy', formatInfoFraction(Math.floor(e.energy), baseMaxEnergy), formatInfoFraction(Math.floor(e.energy), effMaxEnergy));
    html += infoRow('Status', getEntityStatusText(e));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    html += infoRow('Visibility', formatRangeStatTiles(baseVisTiles), formatRangeStatTiles(effVisTiles));
    // // html += infoRow('Upgrade', `${upg.goldCost}g, ENERGY ${upg.energyNow}->${upg.energyNext}`);
    html += infoRow('Unit Energy', Number.isFinite(uEnergy) ? Math.floor(uEnergy) : '?');
    html += infoRow('Unit Atk', Number.isFinite(uAtk) ? Math.floor(uAtk) : '?');
    html += infoRow('Unit Range', formatRangeStatTiles(Number(uRange) || 0));
    html += infoRow('Unit Spd', Number.isFinite(uSpeed) ? uSpeed.toFixed(2) : '?');
    if (e.owner === localPlayerId) {
        html += infoRow('Rally', e.rallyX !== null ? `(${Math.floor(e.rallyX / TILE)},${Math.floor(e.rallyY / TILE)})` : 'None');
    }
    if (e.owner === localPlayerId) {
        let cost = e.getUnitCost();
        let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
        let totalCost = cost * purchaseCount;
        let canQueue = !e.underConstruction;
        let subBtn = canQueue
            ? `<span class="info-dequeue-btn" data-type="unit" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;color:#f44;font-weight:bold;">[-]</span>`
            : `<span style="color:#444;font-weight:bold;">[-]</span>`;
        let addBtn = canQueue
            ? `<span class="info-buy-btn" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;color:#4f4;font-weight:bold;margin-left:4px;">[+]</span>`
            : `<span style="color:#444;font-weight:bold;margin-left:4px;">[+]</span>`;
        let autoEnabled = isAutoUpgradeEnabled(e);
        let buildEnabled = isBuildEnabled(e);
        let salvBtn = `<span class="info-salvage-btn" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;background:${e.markedForSalvage ? '#533' : '#222'};padding:2px 8px;border:1px solid ${e.markedForSalvage ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${e.markedForSalvage ? '#f44' : '#888'}">${e.markedForSalvage ? '\u2620\u2715' : '\u2620'}</span>`;
        let autoBtn = autoUpgradeBtn(e.gx, e.gy, autoEnabled);
        let stackBtn = autoStackBtn(e.gx, e.gy, isAutoStackEnabled(e));
        let queueBtn = queueToggleBtn(e.gx, e.gy, isQueueEnabled(e));
        let buildBtn = e.underConstruction ? buildToggleBtn(e.gx, e.gy, buildEnabled) : disabledInfoPill('\uD83D\uDD28 --');
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;"><span style="color:#fd0;">${formatInfoCurrency(totalCost)}</span><span style="color:#fff;margin:0 6px;">${formatInfoFraction((e.spawnQueue || []).length, 20)}</span><div style="display:flex;align-items:center;">${subBtn}${addBtn}</div></div>`;
        html += renderSpawnerEnergyProgressRow(getSpawnerEnergyProgress(e));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;">${salvBtn}</div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${queueBtn}${stackBtn}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS[bKey] || 'Trains units for combat.');
    return html;
}

function renderBarrackGroupInfo(group) {
    let html = '';
    let e = group[0];
    let bKey = 'barrack_' + e.unitType;
    let uLvl = getThingEffectiveLevel(e);
    let uEnergy = getUnitStatForOwner(e.owner, e.unitType, uLvl, 'energy');
    let uAtk = getUnitStatForOwner(e.owner, e.unitType, uLvl, 'atk');
    let uRange = getUnitStatForOwner(e.owner, e.unitType, uLvl, 'attackRange');
    let uSpeed = getUnitStatForOwner(e.owner, e.unitType, uLvl, 'speed');
    let totalBaseMaxEnergy = 0;
    let totalEffMaxEnergy = 0;
    let totalBaseVis = 0;
    let totalEffVis = 0;
    let readyGroup = group.filter(b => !b.underConstruction);
    let totalEnergy = 0, totalQueue = 0;
    for (let b of group) {
        totalEnergy += b.energy;
        totalBaseMaxEnergy += getEntityBaseEnergyMax(b);
        totalEffMaxEnergy += getEntityEffectiveEnergyMax(b);
        totalBaseVis += Number(getEntityBaseVisibilityRangeTiles(b)) || 0;
        totalEffVis += Number(getEntityEffectiveVisibilityRangeTiles(b)) || 0;
    }
    for (let b of readyGroup) totalQueue += b.spawnQueue.length;
    html += infoRow('Count', group.length);
    html += infoRow('Energy', formatInfoFraction(Math.floor(totalEnergy), totalBaseMaxEnergy), formatInfoFraction(Math.floor(totalEnergy), totalEffMaxEnergy));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    let avgBaseVis = group.length > 0 ? totalBaseVis / group.length : 0;
    let avgEffVis = group.length > 0 ? totalEffVis / group.length : 0;
    html += infoRow('Visibility', `${formatRangeStatTiles(avgBaseVis)} avg`, `${formatRangeStatTiles(avgEffVis)} avg`);
    html += infoRow('Unit Energy', Number.isFinite(uEnergy) ? Math.floor(uEnergy) : '?');
    html += infoRow('Unit Atk', Number.isFinite(uAtk) ? Math.floor(uAtk) : '?');
    html += infoRow('Unit Range', formatRangeStatTiles(Number(uRange) || 0));
    html += infoRow('Unit Spd', Number.isFinite(uSpeed) ? uSpeed.toFixed(2) : '?');
    if (e.owner === localPlayerId) {
        html += infoRow('Rally', e.rallyX !== null ? `(${Math.floor(e.rallyX / TILE)},${Math.floor(e.rallyY / TILE)})` : 'None');
    }
    if (e.owner === localPlayerId) {
        let anyMarked = group.some(b => b.markedForSalvage);
        let allAutoEnabled = group.every(b => isAutoUpgradeEnabled(b));
        let anyAutoEnabled = group.some(b => isAutoUpgradeEnabled(b));
        let hasUnderConstruction = group.some(b => b.underConstruction);
        let allBuildEnabled = group.every(b => isBuildEnabled(b));
        let anyBuildEnabled = group.some(b => isBuildEnabled(b));
        let queueReady = readyGroup;
        let queueCoordStr = queueReady.map(b => `${b.gx},${b.gy}`).join(';');
        let queueCostSource = readyGroup[0] || e;
        let cost = queueCostSource.getUnitCost();
        let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
        let totalCost = cost * purchaseCount;
        let canQueue = queueReady.length > 0;
        let subBtn = canQueue
            ? `<span class="info-dequeue-group-btn" data-type="unit" data-coords="${queueCoordStr}" style="cursor:pointer;color:#f44;font-weight:bold;">[-]</span>`
            : `<span style="color:#444;font-weight:bold;">[-]</span>`;
        let addBtn = canQueue
            ? `<span class="info-buy-group-btn" data-coords="${queueCoordStr}" style="cursor:pointer;color:#4f4;font-weight:bold;margin-left:4px;">[+]</span>`
            : `<span style="color:#444;font-weight:bold;margin-left:4px;">[+]</span>`;
        let coordStr = group.map(b => `${b.gx},${b.gy}`).join(';');
        let salvBtn = `<span class="info-salvage-group-btn" data-coords="${coordStr}" style="cursor:pointer;background:${anyMarked ? '#533' : '#222'};padding:2px 8px;border:1px solid ${anyMarked ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${anyMarked ? '#f44' : '#888'}">${anyMarked ? '\u2620\u2715' : '\u2620'}</span>`;
        let autoBtn = autoUpgradeGroupBtn(coordStr, allAutoEnabled, anyAutoEnabled);
        let stackBtn = autoStackGroupBtn(coordStr, group.every(b => isAutoStackEnabled(b)), group.some(b => isAutoStackEnabled(b)));
        let queueBtn = queueToggleGroupBtn(coordStr, group.every(b => isQueueEnabled(b)), group.some(b => isQueueEnabled(b)));
        let buildBtn = hasUnderConstruction ? buildToggleGroupBtn(coordStr, allBuildEnabled, anyBuildEnabled) : disabledInfoPill('\uD83D\uDD28 --');
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;"><span style="color:#fd0;">${formatInfoCurrency(totalCost)}</span><span style="color:#fff;margin:0 6px;">${formatInfoFraction(totalQueue, Math.max(1, readyGroup.length) * 20)}</span><div style="display:flex;align-items:center;">${subBtn}${addBtn}</div></div>`;
        html += renderSpawnerEnergyProgressRow(getSpawnerGroupEnergyProgress(readyGroup));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;">${salvBtn}</div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${queueBtn}${stackBtn}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS[bKey] || 'Trains units for combat.');
    return html;
}

function renderTowerInfo(e) {
    let html = '';
    let s = e.currentStats || e.baseStats;
    let bs = e.baseStats;
    let baseLevel = stackCountToLevel(e.stacks || 1);
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    let upg = getNextLevelUpgradeInfo(e);
    let dps = s.cd > 0 ? (s.damage / s.cd).toFixed(1) : '0';
    let baseDps = bs && bs.cd > 0 ? (bs.damage / bs.cd).toFixed(1) : '0';
    let baseVis = Number(getEntityBaseVisibilityRangeTiles(e));
    let effVis = Number(getEntityEffectiveVisibilityRangeTiles(e));
    if (!Number.isFinite(baseVis)) baseVis = 0;
    if (!Number.isFinite(effVis)) effVis = baseVis;
    let baseMaxEnergy = getEntityBaseEnergyMax(e);
    let effMaxEnergy = getEntityEffectiveEnergyMax(e);
    html += infoRow('Energy', formatInfoFraction(Math.floor(e.energy), baseMaxEnergy), formatInfoFraction(Math.floor(e.energy), effMaxEnergy));
    html += infoRow('Status', getEntityStatusText(e));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    html += infoRow('Damage', bs ? formatBigNumber(bs.damage, 1) : formatBigNumber(s.damage, 1), formatBigNumber(s.damage, 1));
    if (e.type !== 'laser') {
        html += infoRow('Range', formatRangeStatTiles(baseVis), formatRangeStatTiles(effVis));
        html += infoRow('Visibility', formatRangeStatTiles(baseVis), formatRangeStatTiles(effVis));
        html += infoRow('Cooldown', bs ? `${(bs.cd || 0).toFixed(2)}s` : `${(s.cd || 0).toFixed(2)}s`, `${(s.cd || 0).toFixed(2)}s`);
        html += infoRow('DPS', baseDps, dps);
    } else {
        html += infoRow('DPS', `${(s.damage / 60 * TICK_RATE).toFixed(1)}/s`);
        html += infoRow('Connections', e.connectedLasers.length);
        html += infoRow('Visibility', formatRangeStatTiles(baseVis), formatRangeStatTiles(effVis));
    }
    if (e.type === 'fire') {
        let burnDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'burnDps');
        let burnDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'burnDuration');
        if (Number.isFinite(burnDps)) html += infoRow('Burn DPS', `${(burnDps * TICK_RATE).toFixed(2)}/s`);
        if (Number.isFinite(burnDuration)) html += infoRow('Burn Duration', `${burnDuration.toFixed(1)}s`);
    }
    if (e.type === 'poison') {
        let poisonDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'poisonDps');
        let poisonDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'poisonDuration');
        if (Number.isFinite(poisonDps)) html += infoRow('Poison DPS', `${(poisonDps * TICK_RATE).toFixed(2)}/s`);
        if (Number.isFinite(poisonDuration)) html += infoRow('Poison Duration', `${poisonDuration.toFixed(1)}s`);
    }
    if (e.type === 'ice') {
        let freezeDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'freezeDps');
        let freezeDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'freezeDuration');
        if (Number.isFinite(freezeDps)) html += infoRow('Freeze DPS', `${(freezeDps * TICK_RATE).toFixed(2)}/s`);
        if (Number.isFinite(freezeDuration)) html += infoRow('Freeze Duration', `${freezeDuration.toFixed(1)}s`);
    }
    if (e.type === 'water') {
        let wetDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'wetDuration');
        if (Number.isFinite(wetDuration)) html += infoRow('Wet Duration', `${wetDuration.toFixed(1)}s`);
    }
    if (e.type === 'sand_gun') {
        let sandDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'sandDuration');
        if (Number.isFinite(sandDuration)) html += infoRow('Slow Duration', `${sandDuration.toFixed(1)}s`);
    }
    if (e.type === 'watch_tower') {
        let watchDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'watchDuration');
        if (Number.isFinite(watchDuration)) html += infoRow('Watch Duration', `${watchDuration.toFixed(1)}s`);
    }
    // html += infoRow('Upgrade', `${upg.goldCost}g, ENERGY ${upg.energyNow}->${upg.energyNext}`);
    html += infoRow('Value', `⚡${formatBigNumber((BASE_CARD_TYPES[e.type] || {}).price || '?')}`);
    if (e.owner === localPlayerId) html += infoRow('Rally', getTowerPreferredTargetDisplay(e));
    if (e.owner === localPlayerId) {
        let autoEnabled = isAutoUpgradeEnabled(e);
        let autoBtn = autoUpgradeBtn(e.gx, e.gy, autoEnabled);
        let buildBtn = e.underConstruction ? buildToggleBtn(e.gx, e.gy, isBuildEnabled(e)) : '';
        let stackBtn = autoStackBtn(e.gx, e.gy, isAutoStackEnabled(e));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;"><span class="info-salvage-btn" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;background:${e.markedForSalvage ? '#533' : '#222'};padding:2px 8px;border:1px solid ${e.markedForSalvage ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${e.markedForSalvage ? '#f44' : '#888'}">${e.markedForSalvage ? '\u2620\u2715' : '\u2620'}</span></div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${stackBtn}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS[e.type] || 'Defensive tower.');
    return html;
}

function renderTowerGroupInfo(group) {
    let html = '';
    let e = group[0];
    let totalEnergy = 0, totalBaseMaxEnergy = 0, totalEffMaxEnergy = 0;
    for (let t of group) {
        totalEnergy += t.energy;
        totalBaseMaxEnergy += getEntityBaseEnergyMax(t);
        totalEffMaxEnergy += getEntityEffectiveEnergyMax(t);
    }
    let s = e.currentStats || e.baseStats;
    let bs = e.baseStats;
    let baseLevel = stackCountToLevel(e.stacks || 1);
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    let dps = s.cd > 0 ? (s.damage / s.cd).toFixed(1) : '0';
    let baseDps = bs && bs.cd > 0 ? (bs.damage / bs.cd).toFixed(1) : '0';
    let baseVis = Number(getEntityBaseVisibilityRangeTiles(e));
    let effVis = Number(getEntityEffectiveVisibilityRangeTiles(e));
    if (!Number.isFinite(baseVis)) baseVis = 0;
    if (!Number.isFinite(effVis)) effVis = baseVis;
    html += infoRow('Count', group.length);
    html += infoRow('Energy', formatInfoFraction(Math.floor(totalEnergy), totalBaseMaxEnergy), formatInfoFraction(Math.floor(totalEnergy), totalEffMaxEnergy));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    html += infoRow('Damage', bs ? formatBigNumber(bs.damage, 1) : formatBigNumber(s.damage, 1), formatBigNumber(s.damage, 1));
    if (e.type !== 'laser') {
        html += infoRow('Range', formatRangeStatTiles(baseVis), formatRangeStatTiles(effVis));
        html += infoRow('Visibility', formatRangeStatTiles(baseVis), formatRangeStatTiles(effVis));
        html += infoRow('Cooldown', bs ? `${(bs.cd || 0).toFixed(2)}s` : `${(s.cd || 0).toFixed(2)}s`, `${(s.cd || 0).toFixed(2)}s`);
        html += infoRow('DPS', baseDps, dps);
    } else {
        html += infoRow('DPS', `${(s.damage / 60 * TICK_RATE).toFixed(1)}/s`);
        html += infoRow('Visibility', formatRangeStatTiles(baseVis), formatRangeStatTiles(effVis));
    }
    if (e.type === 'fire') {
        let burnDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'burnDps');
        let burnDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'burnDuration');
        if (Number.isFinite(burnDps)) html += infoRow('Burn DPS', `${(burnDps * TICK_RATE).toFixed(2)}/s`);
        if (Number.isFinite(burnDuration)) html += infoRow('Burn Duration', `${burnDuration.toFixed(1)}s`);
    }
    if (e.type === 'poison') {
        let poisonDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'poisonDps');
        let poisonDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'poisonDuration');
        if (Number.isFinite(poisonDps)) html += infoRow('Poison DPS', `${(poisonDps * TICK_RATE).toFixed(2)}/s`);
        if (Number.isFinite(poisonDuration)) html += infoRow('Poison Duration', `${poisonDuration.toFixed(1)}s`);
    }
    if (e.type === 'ice') {
        let freezeDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'freezeDps');
        let freezeDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'freezeDuration');
        if (Number.isFinite(freezeDps)) html += infoRow('Freeze DPS', `${(freezeDps * TICK_RATE).toFixed(2)}/s`);
        if (Number.isFinite(freezeDuration)) html += infoRow('Freeze Duration', `${freezeDuration.toFixed(1)}s`);
    }
    if (e.type === 'water') {
        let wetDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'wetDuration');
        if (Number.isFinite(wetDuration)) html += infoRow('Wet Duration', `${wetDuration.toFixed(1)}s`);
    }
    if (e.type === 'sand_gun') {
        let sandDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'sandDuration');
        if (Number.isFinite(sandDuration)) html += infoRow('Slow Duration', `${sandDuration.toFixed(1)}s`);
    }
    if (e.type === 'watch_tower') {
        let watchDuration = getBuildingStatForOwner(e.owner, e.type, effLevel, 'watchDuration');
        if (Number.isFinite(watchDuration)) html += infoRow('Watch Duration', `${watchDuration.toFixed(1)}s`);
    }
    html += infoRow('Value', `⚡${formatBigNumber((BASE_CARD_TYPES[e.type] || {}).price || '?')}`);
    if (e.owner === localPlayerId) html += infoRow('Rally', getTowerPreferredTargetDisplay(e));
    if (e.owner === localPlayerId) {
        let anyMarked = group.some(t => t.markedForSalvage);
        let allAutoEnabled = group.every(t => isAutoUpgradeEnabled(t));
        let anyAutoEnabled = group.some(t => isAutoUpgradeEnabled(t));
        let hasUnderConstruction = group.some(t => t.underConstruction);
        let allBuildEnabled = group.every(t => isBuildEnabled(t));
        let anyBuildEnabled = group.some(t => isBuildEnabled(t));
        let coordStr = group.map(t => `${t.gx},${t.gy}`).join(';');
        let autoBtn = autoUpgradeGroupBtn(coordStr, allAutoEnabled, anyAutoEnabled);
        let buildBtn = hasUnderConstruction ? buildToggleGroupBtn(coordStr, allBuildEnabled, anyBuildEnabled) : '';
        let stackBtn = autoStackGroupBtn(coordStr, group.every(t => isAutoStackEnabled(t)), group.some(t => isAutoStackEnabled(t)));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;"><span class="info-salvage-group-btn" data-coords="${coordStr}" style="cursor:pointer;background:${anyMarked ? '#533' : '#222'};padding:2px 8px;border:1px solid ${anyMarked ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${anyMarked ? '#f44' : '#888'}">${anyMarked ? '\u2620\u2715' : '\u2620'}</span></div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${stackBtn}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS[e.type] || 'Defensive tower.');
    return html;
}

function renderSpawnerInfo(e) {
    let html = '';
    let unitLabel = e.type === 'spawner' ? 'Collector' : e.type === 'astar_spawner' ? 'A*er' : e.type === 'builder_spawner' ? 'Builder' : e.type === 'healer_spawner' ? 'Healer' : 'Salvager';
    let baseStacks = e.stacks || 1;
    let sLevel = stackCountToLevel(baseStacks);
    let effStacks = e.effectiveStacks || baseStacks;
    let effLevel = getThingEffectiveLevel(e, sLevel);
    let upg = getNextLevelUpgradeInfo(e);
    let baseVisTiles = getEntityBaseVisibilityRangeTiles(e);
    let effVisTiles = getEntityEffectiveVisibilityRangeTiles(e);
    let baseMaxEnergy = getEntityBaseEnergyMax(e);
    let effMaxEnergy = getEntityEffectiveEnergyMax(e);
    html += infoRow('Energy', formatInfoFraction(Math.floor(e.energy), baseMaxEnergy), formatInfoFraction(Math.floor(e.energy), effMaxEnergy));
    html += infoRow('Status', getEntityStatusText(e));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(baseStacks, sLevel, effStacks, effLevel, getThingManualStacks(e));
    html += infoRow('Visibility', formatRangeStatTiles(baseVisTiles), formatRangeStatTiles(effVisTiles));
    // html += infoRow('Upgrade', `${upg.goldCost}g, ENERGY ${upg.energyNow}->${upg.energyNext}`);
    html += infoRow('Owner', e.owner === localPlayerId ? 'You' : 'Enemy');
    html += infoRow('Value', `⚡${formatBigNumber((BASE_CARD_TYPES[e.type] || {}).price || '?')}`);
    if (e.owner === localPlayerId) {
        html += infoRow('Rally', e.rallyX !== null ? `(${Math.floor(e.rallyX / TILE)},${Math.floor(e.rallyY / TILE)})` : 'None');
        let cost = e.getUnitCost();
        let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
        let totalCost = cost * purchaseCount;
        let canQueue = !e.underConstruction;
        let subBtn = canQueue
            ? `<span class="info-dequeue-btn" data-type="worker" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;color:#f44;font-weight:bold;">[-]</span>`
            : `<span style="color:#444;font-weight:bold;">[-]</span>`;
        let addBtn = canQueue
            ? `<span class="info-buy-worker-btn" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;color:#4f4;font-weight:bold;margin-left:4px;">[+]</span>`
            : `<span style="color:#444;font-weight:bold;margin-left:4px;">[+]</span>`;
        let autoEnabled = isAutoUpgradeEnabled(e);
        let buildEnabled = isBuildEnabled(e);
        let salvBtn = `<span class="info-salvage-btn" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;background:${e.markedForSalvage ? '#533' : '#222'};padding:2px 8px;border:1px solid ${e.markedForSalvage ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${e.markedForSalvage ? '#f44' : '#888'}">${e.markedForSalvage ? '\u2620\u2715' : '\u2620'}</span>`;
        let autoBtn = autoUpgradeBtn(e.gx, e.gy, autoEnabled);
        let stackBtn = autoStackBtn(e.gx, e.gy, isAutoStackEnabled(e));
        let queueBtn = queueToggleBtn(e.gx, e.gy, isQueueEnabled(e));
        let buildBtn = e.underConstruction ? buildToggleBtn(e.gx, e.gy, buildEnabled) : disabledInfoPill('\uD83D\uDD28 --');
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;"><span style="color:#fd0;">${formatInfoCurrency(totalCost)}</span><span style="color:#fff;margin:0 6px;">${formatInfoFraction((e.spawnQueue || []).length, 10)}</span><div style="display:flex;align-items:center;">${subBtn}${addBtn}</div></div>`;
        html += renderSpawnerEnergyProgressRow(getSpawnerEnergyProgress(e));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;">${salvBtn}</div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${queueBtn}${stackBtn}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS[e.type] || 'Spawns worker units.');
    return html;
}

function renderFloorItemInfo(e) {
    let html = '';
    let def = BASE_CARD_TYPES[e.type];
    let baseStacks = e.stacks || 1;
    let baseLevel = stackCountToLevel(baseStacks);
    let effStacks = e.effectiveStacks || baseStacks;
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    let baseStats = calculateItemStats(e.type, baseLevel, e.owner);
    let effStats = calculateItemStats(e.type, effLevel, e.owner);
    let upg = getNextLevelUpgradeInfo(e);
    let baseVisTiles = getEntityBaseVisibilityRangeTiles(e);
    let effVisTiles = getEntityEffectiveVisibilityRangeTiles(e);
    let baseMaxEnergy = getEntityBaseEnergyMax(e);
    let effMaxEnergy = getEntityEffectiveEnergyMax(e);
    if (baseStats.maxEnergy > 0) html += infoRow('Energy', formatInfoFraction(Math.floor(e.energy || baseStats.maxEnergy), baseMaxEnergy), formatInfoFraction(Math.floor(e.energy || baseStats.maxEnergy), effMaxEnergy));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(baseStacks, baseLevel, effStacks, effLevel, getThingManualStacks(e));
    html += infoRow('Visibility', formatRangeStatTiles(baseVisTiles), formatRangeStatTiles(effVisTiles));
    if (effStats.damage > 0) {
        let baseDmg = baseStats.damage, effDmg = effStats.damage;
        if (e.type === 'mine') html += infoRow('Explode Dmg', Math.floor(baseDmg), baseDmg !== effDmg ? Math.floor(effDmg) : undefined);
        else if (e.type === 'lava') {
            let baseBurnDps = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'burnDps');
            let effBurnDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'burnDps');
            let baseBurnDur = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'burnDuration');
            let effBurnDur = getBuildingStatForOwner(e.owner, e.type, effLevel, 'burnDuration');
            html += infoRow('Burn DPS', `${((Number.isFinite(baseBurnDps) ? baseBurnDps : baseDmg) * TICK_RATE).toFixed(2)}/s`, Number.isFinite(effBurnDps) && Math.abs((baseBurnDps || 0) - effBurnDps) > 1e-6 ? `${(effBurnDps * TICK_RATE).toFixed(2)}/s` : undefined);
            if (Number.isFinite(baseBurnDur) || Number.isFinite(effBurnDur)) html += infoRow('Burn Duration', `${(Number.isFinite(baseBurnDur) ? baseBurnDur : 0).toFixed(1)}s`, Number.isFinite(effBurnDur) && baseBurnDur !== effBurnDur ? `${effBurnDur.toFixed(1)}s` : undefined);
        }
        else if (e.type === 'poison_puddle') {
            let basePoisonDps = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'poisonDps');
            let effPoisonDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'poisonDps');
            let basePoisonDur = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'poisonDuration');
            let effPoisonDur = getBuildingStatForOwner(e.owner, e.type, effLevel, 'poisonDuration');
            html += infoRow('Poison DPS', `${((Number.isFinite(basePoisonDps) ? basePoisonDps : baseDmg) * TICK_RATE).toFixed(2)}/s`, Number.isFinite(effPoisonDps) && Math.abs((basePoisonDps || 0) - effPoisonDps) > 1e-6 ? `${(effPoisonDps * TICK_RATE).toFixed(2)}/s` : undefined);
            if (Number.isFinite(basePoisonDur) || Number.isFinite(effPoisonDur)) html += infoRow('Poison Duration', `${(Number.isFinite(basePoisonDur) ? basePoisonDur : 0).toFixed(1)}s`, Number.isFinite(effPoisonDur) && basePoisonDur !== effPoisonDur ? `${effPoisonDur.toFixed(1)}s` : undefined);
        }
        else if (e.type === 'ice_patch') {
            let baseFreezeDps = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'freezeDps');
            let effFreezeDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'freezeDps');
            let baseFreezeDur = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'freezeDuration');
            let effFreezeDur = getBuildingStatForOwner(e.owner, e.type, effLevel, 'freezeDuration');
            html += infoRow('Freeze DPS', `${((Number.isFinite(baseFreezeDps) ? baseFreezeDps : baseDmg) * TICK_RATE).toFixed(2)}/s`, Number.isFinite(effFreezeDps) && Math.abs((baseFreezeDps || 0) - effFreezeDps) > 1e-6 ? `${(effFreezeDps * TICK_RATE).toFixed(2)}/s` : undefined);
            if (Number.isFinite(baseFreezeDur) || Number.isFinite(effFreezeDur)) html += infoRow('Freeze Duration', `${(Number.isFinite(baseFreezeDur) ? baseFreezeDur : 0).toFixed(1)}s`, Number.isFinite(effFreezeDur) && baseFreezeDur !== effFreezeDur ? `${effFreezeDur.toFixed(1)}s` : undefined);
        }
        else html += infoRow('Damage', baseDmg.toFixed(2), baseDmg !== effDmg ? effDmg.toFixed(2) : undefined);
    }
    if (e.type === 'sand') html += infoRow('Effect', '50% slow');
    if (e.type === 'ice_patch') html += infoRow('Effect', '50% slow + freeze');
    if (e.type === 'water_puddle') html += infoRow('Effect', 'Soak (ice combo)');
    if (e.type === 'farm' || e.type === 'astar_farm') {
        let statKey = e.type === 'astar_farm' ? 'astar_farm' : 'farm';
        let baseInc = getBuildingStatForOwner(e.owner, statKey, baseLevel, 'multiplier');
        let effInc = getBuildingStatForOwner(e.owner, statKey, effLevel, 'multiplier');
        if (!Number.isFinite(baseInc)) baseInc = Math.max(1, baseLevel);
        if (!Number.isFinite(effInc)) effInc = Math.max(1, effLevel);
        let gatherLabel = e.type === 'astar_farm' ? 'x A* gather' : 'x gather';
        html += infoRow('Multiplier', `${baseInc.toFixed(2)}${gatherLabel}`, Math.abs(baseInc - effInc) > 1e-6 ? `${effInc.toFixed(2)}${gatherLabel}` : undefined);
    }
    if (e.type === 'house') {
        let basePopCap = getBuildingStatForOwner(e.owner, 'house', baseLevel, 'popCap');
        let effPopCap = getBuildingStatForOwner(e.owner, 'house', effLevel, 'popCap');
        if (!Number.isFinite(basePopCap)) basePopCap = getHousePopCapContribution(e.owner, baseLevel);
        if (!Number.isFinite(effPopCap)) effPopCap = getHousePopCapContribution(e.owner, effLevel);
        html += infoRow('Pop Cap', `+${formatBigNumber(Math.floor(basePopCap))}`, Math.floor(basePopCap) !== Math.floor(effPopCap) ? `+${formatBigNumber(Math.floor(effPopCap))}` : undefined);
    }
    // html += infoRow('Upgrade', `${upg.goldCost}g, ENERGY ${upg.energyNow}->${upg.energyNext}`);
    html += infoRow('Value', `⚡${formatBigNumber(def.price || '?')}`);
    let fgx = e.gx !== undefined ? e.gx : e._gx, fgy = e.gy !== undefined ? e.gy : e._gy;
    if (fgx !== undefined && fgy !== undefined) {
        let autoEnabled = isAutoUpgradeEnabled(e);
        let autoBtn = autoUpgradeBtn(fgx, fgy, autoEnabled);
        let buildBtn = e.underConstruction ? buildToggleBtn(fgx, fgy, isBuildEnabled(e)) : '';
        let stackBtn = autoStackBtn(fgx, fgy, isAutoStackEnabled(e));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;"><span class="info-salvage-btn" data-gx="${fgx}" data-gy="${fgy}" style="cursor:pointer;background:${e.markedForSalvage ? '#533' : '#222'};padding:2px 8px;border:1px solid ${e.markedForSalvage ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${e.markedForSalvage ? '#f44' : '#888'}">${e.markedForSalvage ? '\u2620\u2715' : '\u2620'}</span></div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${stackBtn}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS[e.type] || 'Placed floor item.');
    return html;
}

function renderGoldMineInfo(e) {
    let html = '';
    html += infoRow('Energy', formatInfoFraction(Math.floor(e.gold), e.maxGold));
    let pct = e.maxGold > 0 ? Math.round(e.gold / e.maxGold * 100) : 0;
    html += infoRow('Remaining', `${pct}%`);
    html += infoDesc('Natural energy deposit. Send collectors to gather.');
    return html;
}

function renderAstarMineInfo(e) {
    let html = '';
    html += infoRow('A*', formatInfoFraction(Math.floor(e.astar), e.maxAstar));
    let pct = e.maxAstar > 0 ? Math.round(e.astar / e.maxAstar * 100) : 0;
    html += infoRow('Remaining', `${pct}%`);
    html += infoDesc('Natural A* deposit. Send A*ers to gather.');
    return html;
}

function renderUnitInfo(u) {
    let html = '';
    let s = BASE_UNIT_STATS[u.unitType] || {};
    let lvl = getUnitBaseLevel(u);
    let effLvl = getUnitEffectiveLevel(u, lvl);
    let stacks = getUnitStackCount(u);
    let effStacks = Math.max(1, Math.floor(u.effectiveStacks || stacks));
    let basemaxEnergy = Math.max(1, Math.floor(u.baseLevelmaxEnergy || u.maxEnergy || 1));
    let energyRatio = u.maxEnergy > 0 ? (u.energy / u.maxEnergy) : 1;
    let baseEnergyNow = Math.max(1, Math.floor(basemaxEnergy * energyRatio));

    let baseAtk = Math.max(0, Number(u.baseLevelAttackDamage ?? u.attackDamage) || 0);
    let baseCd = Math.max(1, Number(u.baseLevelAttackCooldown ?? u.attackCooldown) || 1);
    let effAtk = Math.max(0, Number(u.attackDamage) || 0);
    let effCd = Math.max(1, Number(u.attackCooldown) || 1);
    let baseDps = baseCd > 0 ? (baseAtk / baseCd * TICK_RATE).toFixed(1) : '0';
    let effDps = effCd > 0 ? (effAtk / effCd * TICK_RATE).toFixed(1) : '0';

    let slowMul = 1;
    if (u.frozen > 0) slowMul *= 0.5;
    if (u.sandy > 0) slowMul *= 0.5;
    let baseSpd = (Number(u.baseLevelSpeed ?? u.speed) || 0) * slowMul;
    let effSpd = (Number(u.speed) || 0) * slowMul;
    let baseAttackRangeRaw = Number(u.baseLevelAttackRange);
    if (Number.isFinite(baseAttackRangeRaw) && baseAttackRangeRaw > 8) baseAttackRangeRaw = baseAttackRangeRaw / TILE;
    let baseAttackRange = Math.max(0, Number.isFinite(baseAttackRangeRaw) ? baseAttackRangeRaw : ((Number(u.attackRange) || 0) / TILE));
    let effAttackRange = Math.max(0, (Number(u.attackRange) || 0) / TILE);
    let baseVisionRange = Math.max(0, Number(u.baseLevelVisionRange ?? u.baseVisionRange ?? u.visionRange) || 0);
    let effVisionRange = Math.max(0, Number(u.visionRange) || 0);

    html += infoRow(withInfoPanelStatMatrixButton('Energy', { title: `${u.unitType} / Energy`, kind: 'unit', key: u.unitType, statKey: 'energy' }), formatInfoFraction(baseEnergyNow, basemaxEnergy), formatInfoFraction(Math.floor(u.energy), u.maxEnergy));
    html += infoRow('Level', `L${lvl}`, `L${effLvl}`);
    html += infoRowStacks(stacks, lvl, effStacks, effLvl, stacks);
    html += infoRow(withInfoPanelStatMatrixButton('Range', { title: `${u.unitType} / Range`, kind: 'unit', key: u.unitType, statKey: 'attackRange' }), formatRangeStatTiles(baseAttackRange), formatRangeStatTiles(effAttackRange));
    html += infoRow(withInfoPanelStatMatrixButton('Visibility', { title: `${u.unitType} / Vision`, kind: 'unit', key: u.unitType, statKey: 'visionRange' }), formatRangeStatTiles(baseVisionRange), formatRangeStatTiles(effVisionRange));
    if (u.workerType === 'builder') {
        let baseBuild = Number(u.baseLevelBuilderDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'builderDps') || 0;
        let effBuild = Number(u.builderDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'builderDps') || 0;
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        html += infoRow(withInfoPanelStatMatrixButton('Build Speed', { title: `${u.unitType} / Build Speed`, kind: 'unit', key: u.unitType, statKey: 'builderDps' }), `${formatBigNumber(baseBuild, 1)}/trip`, `${formatBigNumber(effBuild, 1)}/trip`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
    } else if (u.workerType === 'healer') {
        let baseHeal = Number(u.baseLevelhealerDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'healerDps') || 0;
        let effHeal = Number(u.healerDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'healerDps') || 0;
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        html += infoRow(withInfoPanelStatMatrixButton('Heal Speed', { title: `${u.unitType} / Heal Speed`, kind: 'unit', key: u.unitType, statKey: 'healerDps' }), `${formatBigNumber(baseHeal, 1)}/trip`, `${formatBigNumber(effHeal, 1)}/trip`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
    } else if (u.workerType === 'researcher') {
        let baseResearch = Number(u.baseLevelResearcherDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'researcherDps') || 0;
        let effResearch = Number(u.researcherDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'researcherDps') || 0;
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        html += infoRow(withInfoPanelStatMatrixButton('Research Speed', { title: `${u.unitType} / Research Speed`, kind: 'unit', key: u.unitType, statKey: 'researcherDps' }), `${formatBigNumber(baseResearch, 1)}/trip`, `${formatBigNumber(effResearch, 1)}/trip`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
    } else if (u.workerType === 'collector' || u.workerType === 'astar_collector') {
        let baseGather = Number(u.baseLevelGatherPerTrip) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'gatherPerTrip') || 0;
        let effGather = Number(u.gatherPerTrip) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'gatherPerTrip') || 0;
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        let gatherLabel = (u.workerType === 'astar_collector') ? 'A* Gather' : 'Gather Speed';
        html += infoRow(withInfoPanelStatMatrixButton(gatherLabel, { title: `${u.unitType} / Gather Speed`, kind: 'unit', key: u.unitType, statKey: 'gatherPerTrip' }), `${formatBigNumber(baseGather, 1)}/trip`, `${formatBigNumber(effGather, 1)}/trip`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
    } else if (u.workerType === 'salvager') {
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        html += infoRow('Salvage Yield', `10% x L${lvl}`, `10% x L${effLvl}`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
    } else {
        html += infoRow(withInfoPanelStatMatrixButton('Attack', { title: `${u.unitType} / Attack`, kind: 'unit', key: u.unitType, statKey: 'atk' }), baseAtk, effAtk);
        html += infoRow(withInfoPanelStatMatrixButton('DPS', {
            title: `${u.unitType} / DPS`,
            getValue: (thingLevel, researchLevel) => {
                let atk = getUnitStatFromMap(u.unitType, thingLevel, 'atk', researchLevel);
                let cd = getUnitStatFromMap(u.unitType, thingLevel, 'atkCd', researchLevel);
                if (!Number.isFinite(atk) || !Number.isFinite(cd) || cd <= 0) return '0';
                return formatBigNumber(atk / cd * TICK_RATE, 1);
            }
        }), baseDps, effDps);
    }
    html += infoRow(withInfoPanelStatMatrixButton('Speed', { title: `${u.unitType} / Speed`, kind: 'unit', key: u.unitType, statKey: 'speed' }), `${baseSpd.toFixed(1)}${(u.frozen > 0 || u.sandy > 0) ? ' (slowed)' : ''}`, `${effSpd.toFixed(1)}${(u.frozen > 0 || u.sandy > 0) ? ' (slowed)' : ''}`);
    let baseAstarCost = Math.max(0.1, Number(u.baseLevelAstarCost ?? getUnitStatForOwner(u.owner, u.unitType, lvl, 'astarCost')) || 1);
    let effAstarCost = Math.max(0.1, Number(u.astarCost ?? getUnitStatForOwner(u.owner, u.unitType, effLvl, 'astarCost')) || baseAstarCost);
    html += infoRow(withInfoPanelStatMatrixButton('A* / Tile', { title: `${u.unitType} / A* Cost`, kind: 'unit', key: u.unitType, statKey: 'astarCost' }), formatBigNumber(baseAstarCost, 2), formatBigNumber(effAstarCost, 2));
    html += infoRow('State', ['Idle', 'Move', 'AtkMove', 'Attack', 'Hold'][u.commandState]);
    let immunes = [];
    if (s.fireResistant) immunes.push('Fire');
    if (s.poisonResistant) immunes.push('Poison');
    if (s.waterResistant) immunes.push('Water');
    if (s.iceResistant) immunes.push('Ice');
    if (s.laserResistant) immunes.push('Laser');
    if (s.turretImmune) immunes.push('Towers');
    if (s.isFlying) immunes.push('Walls');
    if (immunes.length > 0) html += infoRow('Immune', immunes.join(', '));
    let statuses = [];
    if (u.burning > 0) statuses.push(`Burn(${u.burning})`);
    if (u.poisoned > 0) statuses.push(`Psn(${u.poisoned})`);
    if (u.frozen > 0) statuses.push(`Frz(${u.frozen})`);
    if (u.wet > 0) statuses.push(`Wet(${u.wet})`);
    if (u.sandy > 0) statuses.push(`Sand(${u.sandy})`);
    if (statuses.length > 0) html += infoRow('Status', statuses.join(' '));
    if (u.owner === localPlayerId) {
        html += `<div style="margin-top:3px;text-align:center;display:flex;align-items:center;justify-content:center;gap:4px">`;
        html += `<span class="info-salvage-btn" data-unit-id="${u.id}" style="cursor:pointer;background:#222;padding:2px 8px;border:1px solid #555;border-radius:3px;font-size:9px;color:#888">\u2620</span>`;
        html += `<span class="info-scale-group-btn" data-mode="x2" data-ids="${u.id}" data-unit-type="${u.unitType}" data-unit-level="${ignoreLevelSubgroups ? '' : getUnitBaseLevel(u)}" style="cursor:pointer;background:#222;padding:2px 6px;border:1px solid #555;border-radius:3px;font-size:9px;color:#8cf">x2</span>`;
        html += `<span class="info-scale-group-btn" data-mode="d2" data-ids="${u.id}" data-unit-type="${u.unitType}" data-unit-level="${ignoreLevelSubgroups ? '' : getUnitBaseLevel(u)}" style="cursor:pointer;background:#222;padding:2px 6px;border:1px solid #555;border-radius:3px;font-size:9px;color:#fc8">/2</span>`;
        html += `</div>`;
    }
    html += infoDesc(DESCRIPTIONS[u.unitType] || 'Combat unit.');
    return html;
}

function renderUnitGroupInfo(group) {
    let html = '';
    let u0 = group[0];
    let s = BASE_UNIT_STATS[u0.unitType] || {};
    let totalEnergy = 0, totalmaxEnergy = 0;
    let totalbaseEnergy = 0, totalBasemaxEnergy = 0;
    let totalStacks = 0, totalEffStacks = 0;
    let totalBuildSpeed = 0, totalEffBuildSpeed = 0;
    let totalHealSpeed = 0, totalEffHealSpeed = 0;
    let totalCollectorPerTrip = 0, totalEffCollectorPerTrip = 0;
    let totalSalvagerLevel = 0, totalEffSalvagerLevel = 0;
    let totalTransferCd = 0, totalEffTransferCd = 0;
    let totalBaseAttack = 0, totalEffAttack = 0;
    let totalBaseDps = 0, totalEffDps = 0;
    let totalBaseSpeed = 0, totalEffSpeed = 0;
    let totalBaseRange = 0, totalEffRange = 0;
    let totalBaseVision = 0, totalEffVision = 0;
    let totalBaseNextStacks = 0, totalEffNextStacks = 0;
    let baseLevels = new Set(), effLevels = new Set();

    for (let u of group) {
        let lvl = getUnitBaseLevel(u);
        let effLvl = getUnitEffectiveLevel(u, lvl);
        let stacks = getUnitStackCount(u);
        let effStacks = Math.max(1, Math.floor(u.effectiveStacks || stacks));
        let ratio = u.maxEnergy > 0 ? (u.energy / u.maxEnergy) : 1;
        let basemaxEnergy = Math.max(1, Math.floor(u.baseLevelmaxEnergy || u.maxEnergy || 1));
        let baseCurEnergy = Math.max(1, Math.floor(basemaxEnergy * ratio));

        let baseAtk = Math.max(0, Number(u.baseLevelAttackDamage ?? u.attackDamage) || 0);
        let baseCd = Math.max(1, Number(u.baseLevelAttackCooldown ?? u.attackCooldown) || 1);
        let effAtk = Math.max(0, Number(u.attackDamage) || 0);
        let effCd = Math.max(1, Number(u.attackCooldown) || 1);

        let slowMul = 1;
        if (u.frozen > 0) slowMul *= 0.5;
        if (u.sandy > 0) slowMul *= 0.5;

        totalEnergy += u.energy;
        totalmaxEnergy += u.maxEnergy;
        totalbaseEnergy += baseCurEnergy;
        totalBasemaxEnergy += basemaxEnergy;
        totalStacks += stacks;
        totalEffStacks += effStacks;
        totalBaseAttack += baseAtk;
        totalEffAttack += effAtk;
        totalBaseDps += baseCd > 0 ? (baseAtk / baseCd * TICK_RATE) : 0;
        totalEffDps += effCd > 0 ? (effAtk / effCd * TICK_RATE) : 0;
        totalBaseSpeed += (Number(u.baseLevelSpeed ?? u.speed) || 0) * slowMul;
        totalEffSpeed += (Number(u.speed) || 0) * slowMul;
        let baseAttackRangeRaw = Number(u.baseLevelAttackRange);
        if (Number.isFinite(baseAttackRangeRaw) && baseAttackRangeRaw > 8) baseAttackRangeRaw = baseAttackRangeRaw / TILE;
        totalBaseRange += Math.max(0, Number.isFinite(baseAttackRangeRaw) ? baseAttackRangeRaw : ((Number(u.attackRange) || 0) / TILE));
        totalEffRange += Math.max(0, (Number(u.attackRange) || 0) / TILE);
        totalBaseVision += Math.max(0, Number(u.baseLevelVisionRange ?? u.baseVisionRange ?? u.visionRange) || 0);
        totalEffVision += Math.max(0, Number(u.visionRange) || 0);
        totalBaseNextStacks += getRequiredStacksForLevel(lvl + 1);
        totalEffNextStacks += getRequiredStacksForLevel(effLvl + 1);
        baseLevels.add(lvl);
        effLevels.add(effLvl);

        if (u.workerType === 'builder') {
            totalBuildSpeed += (Number(u.baseLevelBuilderDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'builderDps') || 0);
            totalEffBuildSpeed += (Number(u.builderDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'builderDps') || 0);
            totalTransferCd += (getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown') || 0);
            totalEffTransferCd += (getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown') || 0);
        } else if (u.workerType === 'healer') {
            totalHealSpeed += (Number(u.baseLevelhealerDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'healerDps') || 0);
            totalEffHealSpeed += (Number(u.healerDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'healerDps') || 0);
            totalTransferCd += (getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown') || 0);
            totalEffTransferCd += (getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown') || 0);
        } else if (u.workerType === 'researcher') {
            totalBuildSpeed += (Number(u.baseLevelResearcherDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'researcherDps') || 0);
            totalEffBuildSpeed += (Number(u.researcherDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'researcherDps') || 0);
            totalTransferCd += (getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown') || 0);
            totalEffTransferCd += (getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown') || 0);
        } else if (u.workerType === 'collector' || u.workerType === 'astar_collector') {
            totalCollectorPerTrip += (Number(u.baseLevelGatherPerTrip) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'gatherPerTrip') || 0);
            totalEffCollectorPerTrip += (Number(u.gatherPerTrip) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'gatherPerTrip') || 0);
            totalTransferCd += (getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown') || 0);
            totalEffTransferCd += (getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown') || 0);
        } else if (u.workerType === 'salvager') {
            totalSalvagerLevel += lvl;
            totalEffSalvagerLevel += effLvl;
            totalTransferCd += (getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown') || 0);
            totalEffTransferCd += (getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown') || 0);
        }
    }

    let minEffLevel = Math.min(...Array.from(effLevels));
    let maxEffLevel = Math.max(...Array.from(effLevels));
    let isEffectiveMixed = effLevels.size > 1;
    let levelSummary = baseLevels.size > 1
        ? `L${Math.min(...Array.from(baseLevels))}-L${Math.max(...Array.from(baseLevels))}`
        : `L${getUnitBaseLevel(u0)}`;
    let effLevelSummary = isEffectiveMixed ? 'Mixed' : `L${getUnitEffectiveLevel(u0)}`;

    html += infoRow('Count', group.length);
    html += infoRow('Energy', formatInfoFraction(Math.floor(totalbaseEnergy), totalBasemaxEnergy), formatInfoFraction(Math.floor(totalEnergy), totalmaxEnergy));
    html += infoRow('Level', levelSummary, effLevelSummary);
    html += infoRow('Stacks', `${formatBigNumber(totalStacks)}/${formatBigNumber(Math.max(totalStacks, totalBaseNextStacks))}`, `${formatBigNumber(totalEffStacks)}/${formatBigNumber(Math.max(totalEffStacks, totalEffNextStacks))}`);
    let avgBaseRange = totalBaseRange / Math.max(1, group.length);
    let avgEffRange = totalEffRange / Math.max(1, group.length);
    let avgBaseVision = totalBaseVision / Math.max(1, group.length);
    let avgEffVision = totalEffVision / Math.max(1, group.length);
    html += infoRow(withInfoPanelStatMatrixButton('Range', { title: `${u0.unitType} / Range`, kind: 'unit', key: u0.unitType, statKey: 'attackRange' }), `${formatRangeStatTiles(avgBaseRange)} avg`, `${formatRangeStatTiles(avgEffRange)} avg`);
    html += infoRow(withInfoPanelStatMatrixButton('Visibility', { title: `${u0.unitType} / Vision`, kind: 'unit', key: u0.unitType, statKey: 'visionRange' }), `${formatRangeStatTiles(avgBaseVision)} avg`, `${formatRangeStatTiles(avgEffVision)} avg`);
    if (u0.workerType === 'builder') {
        html += infoRow(withInfoPanelStatMatrixButton('Build Speed', { title: `${u0.unitType} / Build Speed`, kind: 'unit', key: u0.unitType, statKey: 'builderDps' }), `${formatBigNumber(totalBuildSpeed, 1)}/trip`, `${formatBigNumber(totalEffBuildSpeed, 1)}/trip`);
        html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u0.unitType} / Transfer CD`, kind: 'unit', key: u0.unitType, statKey: 'transferCooldown' }), `${(totalTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`, `${(totalEffTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`);
    } else if (u0.workerType === 'healer') {
        html += infoRow(withInfoPanelStatMatrixButton('Heal Speed', { title: `${u0.unitType} / Heal Speed`, kind: 'unit', key: u0.unitType, statKey: 'healerDps' }), `${formatBigNumber(totalHealSpeed, 1)}/trip`, `${formatBigNumber(totalEffHealSpeed, 1)}/trip`);
        html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u0.unitType} / Transfer CD`, kind: 'unit', key: u0.unitType, statKey: 'transferCooldown' }), `${(totalTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`, `${(totalEffTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`);
    } else if (u0.workerType === 'researcher') {
        html += infoRow(withInfoPanelStatMatrixButton('Research Speed', { title: `${u0.unitType} / Research Speed`, kind: 'unit', key: u0.unitType, statKey: 'researcherDps' }), `${formatBigNumber(totalBuildSpeed, 1)}/trip`, `${formatBigNumber(totalEffBuildSpeed, 1)}/trip`);
        html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u0.unitType} / Transfer CD`, kind: 'unit', key: u0.unitType, statKey: 'transferCooldown' }), `${(totalTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`, `${(totalEffTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`);
    } else if (u0.workerType === 'collector' || u0.workerType === 'astar_collector') {
        let gatherLabel = (u0.workerType === 'astar_collector') ? 'A* Gather' : 'Gather Speed';
        html += infoRow(withInfoPanelStatMatrixButton(gatherLabel, { title: `${u0.unitType} / Gather Speed`, kind: 'unit', key: u0.unitType, statKey: 'gatherPerTrip' }), `${formatBigNumber(totalCollectorPerTrip, 1)}/trip`, `${formatBigNumber(totalEffCollectorPerTrip, 1)}/trip`);
        html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u0.unitType} / Transfer CD`, kind: 'unit', key: u0.unitType, statKey: 'transferCooldown' }), `${(totalTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`, `${(totalEffTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`);
    } else if (u0.workerType === 'salvager') {
        html += infoRow('Salvage Yield', `10% x SumL${totalSalvagerLevel}`, `10% x SumL${totalEffSalvagerLevel}`);
        html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u0.unitType} / Transfer CD`, kind: 'unit', key: u0.unitType, statKey: 'transferCooldown' }), `${(totalTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`, `${(totalEffTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`);
    } else {
        html += infoRow(withInfoPanelStatMatrixButton('Attack', { title: `${u0.unitType} / Attack`, kind: 'unit', key: u0.unitType, statKey: 'atk' }), formatBigNumber(totalBaseAttack, 1), formatBigNumber(totalEffAttack, 1));
        html += infoRow(withInfoPanelStatMatrixButton('DPS', {
            title: `${u0.unitType} / DPS`,
            getValue: (thingLevel, researchLevel) => {
                let atk = getUnitStatFromMap(u0.unitType, thingLevel, 'atk', researchLevel);
                let cd = getUnitStatFromMap(u0.unitType, thingLevel, 'atkCd', researchLevel);
                if (!Number.isFinite(atk) || !Number.isFinite(cd) || cd <= 0) return '0';
                return formatBigNumber(atk / cd * TICK_RATE, 1);
            }
        }), totalBaseDps.toFixed(1), totalEffDps.toFixed(1));
    }
    let avgBaseSpeed = totalBaseSpeed / Math.max(1, group.length);
    let avgEffSpeed = totalEffSpeed / Math.max(1, group.length);
    html += infoRow(withInfoPanelStatMatrixButton('Speed', { title: `${u0.unitType} / Speed`, kind: 'unit', key: u0.unitType, statKey: 'speed' }), `${avgBaseSpeed.toFixed(1)} avg`, `${avgEffSpeed.toFixed(1)} avg`);
    if (isEffectiveMixed) html += infoRow('Levels (Eff)', `Mixed (L${minEffLevel}-L${maxEffLevel})`);
    let immunes = [];
    if (s.fireResistant) immunes.push('Fire');
    if (s.poisonResistant) immunes.push('Poison');
    if (s.waterResistant) immunes.push('Water');
    if (s.iceResistant) immunes.push('Ice');
    if (s.laserResistant) immunes.push('Laser');
    if (s.turretImmune) immunes.push('Towers');
    if (s.isFlying) immunes.push('Walls');
    if (immunes.length > 0) html += infoRow('Immune', immunes.join(', '));
    if (u0.owner === localPlayerId) {
        let ids = group.map(u => u.id).join(',');
        let subgroupLevel = ignoreLevelSubgroups ? '' : getUnitBaseLevel(u0);
        html += `<div style="margin-top:3px;text-align:center;display:flex;align-items:center;justify-content:center;gap:4px">`;
        html += `<span class="info-kill-group-btn" data-ids="${ids}" style="cursor:pointer;background:#222;padding:2px 8px;border:1px solid #555;border-radius:3px;font-size:9px;color:#888">\u2620x${group.length}</span>`;
        html += `<span class="info-scale-group-btn" data-mode="x2" data-ids="${ids}" data-unit-type="${u0.unitType}" data-unit-level="${subgroupLevel}" style="cursor:pointer;background:#222;padding:2px 6px;border:1px solid #555;border-radius:3px;font-size:9px;color:#8cf">x2</span>`;
        html += `<span class="info-scale-group-btn" data-mode="d2" data-ids="${ids}" data-unit-type="${u0.unitType}" data-unit-level="${subgroupLevel}" style="cursor:pointer;background:#222;padding:2px 6px;border:1px solid #555;border-radius:3px;font-size:9px;color:#fc8">/2</span>`;
        html += `</div>`;
    }
    html += infoDesc(DESCRIPTIONS[u0.unitType] || 'Combat unit.');
    return html;
}

function renderEntityBlock(e) {
    if (e._isGoldMine) return renderGoldMineInfo(e);
    if (e._isAstarMine) return renderAstarMineInfo(e);
    let ctx = getInfoPanelMatrixContextForEntity(e);
    if (e.type === 'barrack' && e.unitType) return runWithInfoPanelStatMatrixContext(ctx, () => renderBarrackInfo(e));
    if (e instanceof Tower) return runWithInfoPanelStatMatrixContext(ctx, () => renderTowerInfo(e));
    if (e.type === 'research') return runWithInfoPanelStatMatrixContext(ctx, () => renderResearchInfo(e));
    if (e.type === 'spawner' || e.type === 'astar_spawner' || e.type === 'salvager' || e.type === 'builder_spawner' || e.type === 'healer_spawner') return runWithInfoPanelStatMatrixContext(ctx, () => renderSpawnerInfo(e));
    if (e.type && BASE_CARD_TYPES[e.type]) return runWithInfoPanelStatMatrixContext(ctx, () => renderFloorItemInfo(e));
    return '';
}

function renderEntityGroupBlock(group) {
    let e = group[0];
    let ctx = getInfoPanelMatrixContextForEntity(e);
    if (e.type === 'barrack' && e.unitType) return runWithInfoPanelStatMatrixContext(ctx, () => renderBarrackGroupInfo(group));
    if (e instanceof Tower) return runWithInfoPanelStatMatrixContext(ctx, () => renderTowerGroupInfo(group));
    if (e._isGoldMine) return renderGoldMineGroupInfo(group);
    if (e._isAstarMine) return renderAstarMineGroupInfo(group);
    if (e.type === 'research') return runWithInfoPanelStatMatrixContext(ctx, () => renderResearchGroupInfo(group));
    if (e.type === 'spawner' || e.type === 'astar_spawner' || e.type === 'salvager' || e.type === 'builder_spawner' || e.type === 'healer_spawner') return runWithInfoPanelStatMatrixContext(ctx, () => renderSpawnerGroupInfo(group));
    if (e.type && BASE_CARD_TYPES[e.type]) return runWithInfoPanelStatMatrixContext(ctx, () => renderFloorItemGroupInfo(group));
    return '';
}

function renderGoldMineGroupInfo(group) {
    let html = '';
    let totalGold = 0, totalMax = 0;
    for (let m of group) { totalGold += m.gold; totalMax += m.maxGold; }
    html += infoRow('Count', group.length);
    html += infoRow('Energy', formatInfoFraction(Math.floor(totalGold), totalMax));
    let pct = totalMax > 0 ? Math.round(totalGold / totalMax * 100) : 0;
    html += infoRow('Remaining', `${pct}%`);
    html += infoDesc('Natural energy deposit. Send collectors to gather.');
    return html;
}

function renderAstarMineGroupInfo(group) {
    let html = '';
    let totalAstar = 0, totalMax = 0;
    for (let m of group) { totalAstar += m.astar; totalMax += m.maxAstar; }
    html += infoRow('Count', group.length);
    html += infoRow('A*', formatInfoFraction(Math.floor(totalAstar), totalMax));
    let pct = totalMax > 0 ? Math.round(totalAstar / totalMax * 100) : 0;
    html += infoRow('Remaining', `${pct}%`);
    html += infoDesc('Natural A* deposit. Send A*ers to gather.');
    return html;
}

function renderSpawnerGroupInfo(group) {
    let html = '';
    let e = group[0];
    let label = e.type === 'spawner' ? 'Collector' : e.type === 'astar_spawner' ? 'A*er' : e.type === 'builder_spawner' ? 'Builder' : e.type === 'healer_spawner' ? 'Healer' : 'Salvager';
    let unitLabel = e.type === 'spawner' ? 'Collector' : e.type === 'astar_spawner' ? 'A*er' : e.type === 'builder_spawner' ? 'Builder' : e.type === 'healer_spawner' ? 'Healer' : 'Salvager';
    let baseStacks = e.stacks || 1;
    let sLevel = stackCountToLevel(baseStacks);
    let effStacks = e.effectiveStacks || baseStacks;
    let effLevel = getThingEffectiveLevel(e, sLevel);
    let totalBaseMaxEnergy = 0;
    let totalEffMaxEnergy = 0;
    let totalBaseVis = 0;
    let totalEffVis = 0;
    let readyGroup = group.filter(s => !s.underConstruction);
    let totalEnergy = 0, totalQueue = 0;
    for (let s of group) {
        totalEnergy += s.energy;
        totalBaseMaxEnergy += getEntityBaseEnergyMax(s);
        totalEffMaxEnergy += getEntityEffectiveEnergyMax(s);
        totalBaseVis += Number(getEntityBaseVisibilityRangeTiles(s)) || 0;
        totalEffVis += Number(getEntityEffectiveVisibilityRangeTiles(s)) || 0;
    }
    for (let s of readyGroup) totalQueue += (s.spawnQueue || []).length;
    html += infoRow('Count', group.length);
    html += infoRow('Energy', formatInfoFraction(Math.floor(totalEnergy), totalBaseMaxEnergy), formatInfoFraction(Math.floor(totalEnergy), totalEffMaxEnergy));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(baseStacks, sLevel, effStacks, effLevel, getThingManualStacks(e));
    let avgBaseVis = group.length > 0 ? totalBaseVis / group.length : 0;
    let avgEffVis = group.length > 0 ? totalEffVis / group.length : 0;
    html += infoRow('Visibility', `${formatRangeStatTiles(avgBaseVis)} avg`, `${formatRangeStatTiles(avgEffVis)} avg`);
    html += infoRow('Owner', e.owner === localPlayerId ? 'You' : 'Enemy');
    html += infoRow('Value', `⚡${formatBigNumber((BASE_CARD_TYPES[e.type] || {}).price || '?')}`);
    if (e.owner === localPlayerId) {
        let anyMarked = group.some(s => s.markedForSalvage);
        let allAutoEnabled = group.every(s => isAutoUpgradeEnabled(s));
        let anyAutoEnabled = group.some(s => isAutoUpgradeEnabled(s));
        let hasUnderConstruction = group.some(s => s.underConstruction);
        let allBuildEnabled = group.every(s => isBuildEnabled(s));
        let anyBuildEnabled = group.some(s => isBuildEnabled(s));
        let queueReady = readyGroup;
        let queueCoordStr = queueReady.map(s => `${s.gx},${s.gy}`).join(';');
        let queueCostSource = readyGroup[0] || e;
        let cost = queueCostSource.getUnitCost();
        let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
        let totalCost = cost * purchaseCount;
        let canQueue = queueReady.length > 0;
        let subBtn = canQueue
            ? `<span class="info-dequeue-group-btn" data-type="worker" data-coords="${queueCoordStr}" style="cursor:pointer;color:#f44;font-weight:bold;">[-]</span>`
            : `<span style="color:#444;font-weight:bold;">[-]</span>`;
        let addBtn = canQueue
            ? `<span class="info-buy-worker-group-btn" data-coords="${queueCoordStr}" style="cursor:pointer;color:#4f4;font-weight:bold;margin-left:4px;">[+]</span>`
            : `<span style="color:#444;font-weight:bold;margin-left:4px;">[+]</span>`;
        let coordStr = group.map(s => `${s.gx},${s.gy}`).join(';');
        let salvBtn = `<span class="info-salvage-group-btn" data-coords="${coordStr}" style="cursor:pointer;background:${anyMarked ? '#533' : '#222'};padding:2px 8px;border:1px solid ${anyMarked ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${anyMarked ? '#f44' : '#888'}">${anyMarked ? '\u2620\u2715' : '\u2620'}</span>`;
        let autoBtn = autoUpgradeGroupBtn(coordStr, allAutoEnabled, anyAutoEnabled);
        let stackBtn = autoStackGroupBtn(coordStr, group.every(s => isAutoStackEnabled(s)), group.some(s => isAutoStackEnabled(s)));
        let queueBtn = queueToggleGroupBtn(coordStr, group.every(s => isQueueEnabled(s)), group.some(s => isQueueEnabled(s)));
        let buildBtn = hasUnderConstruction ? buildToggleGroupBtn(coordStr, allBuildEnabled, anyBuildEnabled) : disabledInfoPill('\uD83D\uDD28 --');
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;"><span style="color:#fd0;">${formatInfoCurrency(totalCost)}</span><span style="color:#fff;margin:0 6px;">${formatInfoFraction(totalQueue, Math.max(1, readyGroup.length) * 10)}</span><div style="display:flex;align-items:center;">${subBtn}${addBtn}</div></div>`;
        html += renderSpawnerEnergyProgressRow(getSpawnerGroupEnergyProgress(readyGroup));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;">${salvBtn}</div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${queueBtn}${stackBtn}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS[e.type] || 'Spawns worker units.');
    return html;
}

function getResearchPanelScopeKey(owner, scope) {
    return `${owner}:${scope}`;
}

function isResearchQueuePanelOpen(owner, scope) {
    return researchQueuePanelOpenState[getResearchPanelScopeKey(owner, scope)] === true;
}

function getResearchOrderedTasksForSingleBuilding(researchBuilding) {
    let out = [];
    if (!researchBuilding) return out;
    let owner = researchBuilding.owner;
    let task = getPlayerResearchTask(owner);
    let queue = getPlayerResearchQueue(owner);
    if (task) out.push({ ...task, isActiveTask: true });
    for (let q of queue) out.push({ ...q, isActiveTask: false });
    return out;
}

function getResearchPreviewThingLevel() {
    return Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(researchPreviewThingLevel) || 1)));
}

function setResearchPreviewThingLevel(level) {
    researchPreviewThingLevel = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(level) || 1)));
}

function getResearchStatValueAtLevel(kind, key, statKey, researchLevel, thingLevel = getResearchPreviewThingLevel()) {
    let rLvl = Math.max(0, Math.floor(researchLevel || 0));
    let tLvl = Math.max(1, Math.min(MAX_THING_LEVEL, Math.floor(Number(thingLevel) || 1)));
    if (kind === 'unit') return getUnitStatFromMap(key, tLvl, statKey, rLvl);
    if (kind === 'building') return getBuildingStatFromMap(key, tLvl, statKey, rLvl);
    return NaN;
}

function closeResearchThingLevelDropdown() {
    if (researchThingLevelDropdown && researchThingLevelDropdown.parentNode) {
        researchThingLevelDropdown.parentNode.removeChild(researchThingLevelDropdown);
    }
    researchThingLevelDropdown = null;
    if (researchThingLevelDropdownOutsideHandler) {
        document.removeEventListener('mousedown', researchThingLevelDropdownOutsideHandler, true);
        researchThingLevelDropdownOutsideHandler = null;
    }
}

function openResearchThingLevelDropdown(anchorEl, opts) {
    if (!anchorEl || !opts) return;
    closeResearchThingLevelDropdown();

    let kind = String(opts.kind || '');
    let key = String(opts.key || '');
    let statKey = String(opts.statKey || '');
    let fromLevel = Math.max(0, Math.floor(Number(opts.fromLevel) || 0));
    let toLevel = Math.max(0, Math.floor(Number(opts.toLevel) || 0));
    if (!kind || !key || !statKey) return;

    let menu = document.createElement('div');
    menu.style.position = 'fixed';
    menu.style.zIndex = '12000';
    menu.style.background = '#121a21';
    menu.style.border = '1px solid #35516a';
    menu.style.borderRadius = '4px';
    menu.style.padding = '4px';
    menu.style.maxHeight = '240px';
    menu.style.overflowY = 'auto';
    menu.style.minWidth = '220px';
    menu.style.boxShadow = '0 6px 18px rgba(0,0,0,0.45)';

    let head = document.createElement('div');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '6px';
    head.style.padding = '2px 4px 4px 4px';
    head.style.borderBottom = '1px solid #2b3f50';
    head.style.marginBottom = '4px';

    let showAllBtn = document.createElement('button');
    showAllBtn.type = 'button';
    showAllBtn.textContent = 'M';
    showAllBtn.title = 'Show all levels';
    showAllBtn.style.cursor = 'pointer';
    showAllBtn.style.background = '#1a2631';
    showAllBtn.style.border = '1px solid #486179';
    showAllBtn.style.color = '#cfe6ff';
    showAllBtn.style.borderRadius = '3px';
    showAllBtn.style.fontSize = '11px';
    showAllBtn.style.padding = '1px 4px';
    showAllBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openResearchStatMatrixPopup(kind, key, statKey, fromLevel, toLevel);
    });

    let hint = document.createElement('span');
    hint.textContent = ': visual only, R is L independent';
    hint.style.color = '#9ab4cb';
    hint.style.fontSize = '10px';
    hint.style.whiteSpace = 'nowrap';

    head.appendChild(showAllBtn);
    head.appendChild(hint);
    menu.appendChild(head);

    let selectedThingLevel = getResearchPreviewThingLevel();
    for (let thingLevel = 1; thingLevel <= MAX_THING_LEVEL; thingLevel++) {
        let fromValue = getResearchStatValueAtLevel(kind, key, statKey, fromLevel, thingLevel);
        let toValue = getResearchStatValueAtLevel(kind, key, statKey, toLevel, thingLevel);
        if (!Number.isFinite(fromValue) && !Number.isFinite(toValue)) continue;
        if (!Number.isFinite(fromValue)) fromValue = toValue;
        if (!Number.isFinite(toValue)) toValue = fromValue;

        let row = document.createElement('div');
        row.style.cursor = 'pointer';
        row.style.padding = '3px 6px';
        row.style.borderRadius = '3px';
        row.style.color = '#cfe6ff';
        row.style.fontSize = '11px';
        row.style.whiteSpace = 'nowrap';
        row.style.background = (thingLevel === selectedThingLevel) ? '#1f3750' : 'transparent';
        row.textContent = `L${thingLevel}: ${formatResearchStatValue(statKey, fromValue)}->${formatResearchStatValue(statKey, toValue)}`;
        row.addEventListener('mouseenter', () => {
            if (thingLevel !== getResearchPreviewThingLevel()) row.style.background = '#183048';
        });
        row.addEventListener('mouseleave', () => {
            row.style.background = (thingLevel === getResearchPreviewThingLevel()) ? '#1f3750' : 'transparent';
        });
        row.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setResearchPreviewThingLevel(thingLevel);
            closeResearchThingLevelDropdown();
            updateInfoPanel();
            renderResearchPopupContent();
        });
        menu.appendChild(row);
    }

    let rect = anchorEl.getBoundingClientRect();
    document.body.appendChild(menu);
    let left = rect.left;
    let top = rect.bottom + 4;
    let maxLeft = window.innerWidth - menu.offsetWidth - 6;
    let maxTop = window.innerHeight - menu.offsetHeight - 6;
    menu.style.left = `${Math.max(6, Math.min(maxLeft, left))}px`;
    menu.style.top = `${Math.max(6, Math.min(maxTop, top))}px`;

    researchThingLevelDropdown = menu;
    researchThingLevelDropdownOutsideHandler = (ev) => {
        if (!researchThingLevelDropdown) return;
        if (researchThingLevelDropdown.contains(ev.target)) return;
        if (anchorEl.contains && anchorEl.contains(ev.target)) return;
        closeResearchThingLevelDropdown();
    };
    document.addEventListener('mousedown', researchThingLevelDropdownOutsideHandler, true);
}

function getQueuedResearchTaskPreview(owner, orderedTasks, taskIndex) {
    if (!Array.isArray(orderedTasks) || taskIndex < 0 || taskIndex >= orderedTasks.length) return null;
    let t = orderedTasks[taskIndex];
    if (!t) return null;

    let baseLevel = getPlayerResearchLevel(owner, t.kind, t.key, t.statKey);
    let priorSameStat = 0;
    for (let i = 0; i < taskIndex; i++) {
        let p = orderedTasks[i];
        if (!p) continue;
        if (p.kind === t.kind && p.key === t.key && p.statKey === t.statKey) priorSameStat++;
    }

    let fromLevel = Math.min(MAX_RESEARCH_LEVEL, baseLevel + priorSameStat);
    let atMax = fromLevel >= MAX_RESEARCH_LEVEL;
    let toLevel = atMax ? fromLevel : Math.min(MAX_RESEARCH_LEVEL, fromLevel + 1);

    let cost = atMax ? 0 : getResearchCost(t.kind, t.key, t.statKey, fromLevel);
    let work = atMax ? 0 : getResearchWork(t.kind, t.key, t.statKey, fromLevel);

    let fromValue = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, fromLevel);
    let toValue = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, toLevel);
    if (!Number.isFinite(fromValue)) fromValue = getResearchCurrentStatValue(owner, t.kind, t.key, t.statKey);
    if (!Number.isFinite(toValue)) toValue = fromValue;

    return { fromLevel, toLevel, atMax, cost, work, fromValue, toValue };
}

function renderQueuedResearchTasksForSingleBuilding(e) {
    let html = '';
    let orderedTasks = getResearchOrderedTasksForSingleBuilding(e);
    if (orderedTasks.length <= 0) {
        html += `<div style="font-size:10px;color:#777;padding:4px 0">Queue is empty.</div>`;
        return html;
    }

    html += `<div style="display:flex;flex-direction:column;gap:4px">`;
    for (let i = 0; i < orderedTasks.length; i++) {
        let t = orderedTasks[i];
        let preview = getQueuedResearchTaskPreview(e.owner, orderedTasks, i);
        if (!preview) continue;
        let thing = getResearchThing(t.kind, t.key);
        let stat = getResearchStatEntry(t.kind, t.key, t.statKey);
        let thingLabel = thing ? thing.label : `${t.kind}:${t.key}`;
        let statLabel = stat ? stat.label : (t.statKey || 'stat');
        let canAfford = !preview.atMax;
        let selectedThingLevel = getResearchPreviewThingLevel();
        let baseValue = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, 0, selectedThingLevel);
        let projectedMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(preview.toValue))
            ? (preview.toValue / baseValue)
            : NaN;

        let pendingIndex = t.isActiveTask ? -1 : (i - ((orderedTasks[0] && orderedTasks[0].isActiveTask) ? 1 : 0));

        html += `<div class="info-research-queue-item" data-owner="${e.owner}" data-gx="${e.gx}" data-gy="${e.gy}" data-active="${t.isActiveTask ? '1' : '0'}" data-pending-index="${pendingIndex}" style="padding:4px;border:1px solid #242424;border-radius:4px;background:#101010;">`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#bbb"><button type="button" class="info-research-stat-matrix-btn" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" data-from-level="${preview.fromLevel}" data-to-level="${preview.toLevel}" style="cursor:pointer;background:#111;color:#9cf;border:1px solid #355;border-radius:3px;padding:0 5px;height:18px;line-height:16px;font-size:10px;">M</button><span>${thingLabel} / ${statLabel}</span></span>`;
        html += `<span style="color:#8fc;min-width:54px;text-align:right;display:inline-block;">x${formatResearchMultiplierValue(projectedMultiplier)}</span>`;
        html += `</div>`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#fd0"><button type="button" class="info-research-move-top-btn" data-owner="${e.owner}" data-gx="${e.gx}" data-gy="${e.gy}" data-active="${t.isActiveTask ? '1' : '0'}" data-pending-index="${pendingIndex}" title="Move to first in queue" style="cursor:pointer;color:#9cf;background:#141414;border:1px solid #355;border-radius:3px;padding:0 4px;line-height:12px;font-size:10px;">↑</button><button type="button" class="info-research-move-bottom-btn" data-owner="${e.owner}" data-gx="${e.gx}" data-gy="${e.gy}" data-active="${t.isActiveTask ? '1' : '0'}" data-pending-index="${pendingIndex}" title="Move to last in queue" style="cursor:pointer;color:#9cf;background:#141414;border:1px solid #355;border-radius:3px;padding:0 4px;line-height:12px;font-size:10px;">↓</button><span>${preview.atMax ? 'MAX' : formatInfoCurrency(preview.cost)} <span style="color:#9cf">R${preview.toLevel}</span></span></span>`;
        html += `<div style="display:flex;align-items:center;gap:4px">`;
        html += `<span class="info-research-dequeue-btn" data-gx="${e.gx}" data-gy="${e.gy}" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" style="cursor:pointer;color:#f66;font-weight:bold;">[-]</span>`;
        html += `<span class="info-research-buy-btn" data-gx="${e.gx}" data-gy="${e.gy}" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" style="cursor:${preview.atMax ? 'default' : 'pointer'};color:${canAfford ? '#4f4' : '#242'};font-weight:bold;">[+]</span>`;
        html += `</div>`;
        html += `</div>`;
        if (t.isActiveTask && Number.isFinite(t.workRequired) && t.workRequired > 0) {
            html += renderResearchWorkProgressRow(t.workDone || 0, t.workRequired);
        }
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}

function renderQueuedResearchTasksForGroup(group) {
    let html = '';
    if (!Array.isArray(group) || group.length <= 0) {
        html += `<div style="font-size:10px;color:#777;padding:4px 0">Queue is empty.</div>`;
        return html;
    }
    let owner = group[0].owner;
    let orderedTasks = getResearchOrderedTasksForSingleBuilding(group[0]);
    if (orderedTasks.length <= 0) {
        html += `<div style="font-size:10px;color:#777;padding:4px 0">Queue is empty.</div>`;
        return html;
    }

    let anchor = group[0];
    let labCount = group.filter(r => r && r.type === 'research' && r.owner === owner && r.energy > 0 && !r.underConstruction).length;
    html += `<div style="display:flex;flex-direction:column;gap:6px">`;
    html += `<div style="border:1px solid #2a2a2a;border-radius:4px;padding:4px;background:#111">`;
    html += `<div style="font-size:10px;color:#9cf;margin-bottom:4px">Shared Queue (${labCount} labs)</div>`;
    html += `<div style="display:flex;flex-direction:column;gap:4px">`;

    for (let i = 0; i < orderedTasks.length; i++) {
        let t = orderedTasks[i];
        let preview = getQueuedResearchTaskPreview(owner, orderedTasks, i);
        if (!preview) continue;
        let thing = getResearchThing(t.kind, t.key);
        let stat = getResearchStatEntry(t.kind, t.key, t.statKey);
        let thingLabel = thing ? thing.label : `${t.kind}:${t.key}`;
        let statLabel = stat ? stat.label : (t.statKey || 'stat');
        let canAfford = !preview.atMax;
        let selectedThingLevel = getResearchPreviewThingLevel();
        let baseValue = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, 0, selectedThingLevel);
        let projectedMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(preview.toValue))
            ? (preview.toValue / baseValue)
            : NaN;

        let pendingIndex = t.isActiveTask ? -1 : (i - ((orderedTasks[0] && orderedTasks[0].isActiveTask) ? 1 : 0));

        html += `<div class="info-research-queue-item" data-owner="${owner}" data-gx="${anchor.gx}" data-gy="${anchor.gy}" data-active="${t.isActiveTask ? '1' : '0'}" data-pending-index="${pendingIndex}" style="padding:4px;border:1px solid #242424;border-radius:4px;background:#101010;">`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#bbb"><button type="button" class="info-research-stat-matrix-btn" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" data-from-level="${preview.fromLevel}" data-to-level="${preview.toLevel}" style="cursor:pointer;background:#111;color:#9cf;border:1px solid #355;border-radius:3px;padding:0 5px;height:18px;line-height:16px;font-size:10px;">M</button><span>${thingLabel} / ${statLabel}</span></span>`;
        html += `<span style="color:#8fc;min-width:54px;text-align:right;display:inline-block;">x${formatResearchMultiplierValue(projectedMultiplier)}</span>`;
        html += `</div>`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#fd0"><button type="button" class="info-research-move-top-btn" data-owner="${owner}" data-gx="${anchor.gx}" data-gy="${anchor.gy}" data-active="${t.isActiveTask ? '1' : '0'}" data-pending-index="${pendingIndex}" title="Move to first in queue" style="cursor:pointer;color:#9cf;background:#141414;border:1px solid #355;border-radius:3px;padding:0 4px;line-height:12px;font-size:10px;">↑</button><button type="button" class="info-research-move-bottom-btn" data-owner="${owner}" data-gx="${anchor.gx}" data-gy="${anchor.gy}" data-active="${t.isActiveTask ? '1' : '0'}" data-pending-index="${pendingIndex}" title="Move to last in queue" style="cursor:pointer;color:#9cf;background:#141414;border:1px solid #355;border-radius:3px;padding:0 4px;line-height:12px;font-size:10px;">↓</button><span>${preview.atMax ? 'MAX' : formatInfoCurrency(preview.cost)} <span style="color:#9cf">R${preview.toLevel}</span></span></span>`;
        html += `<div style="display:flex;align-items:center;gap:4px">`;
        html += `<span class="info-research-dequeue-btn" data-gx="${anchor.gx}" data-gy="${anchor.gy}" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" style="cursor:pointer;color:#f66;font-weight:bold;">[-]</span>`;
        html += `<span class="info-research-buy-btn" data-gx="${anchor.gx}" data-gy="${anchor.gy}" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" style="cursor:${preview.atMax ? 'default' : 'pointer'};color:${canAfford ? '#4f4' : '#242'};font-weight:bold;">[+]</span>`;
        html += `</div>`;
        html += `</div>`;
        if (t.isActiveTask && Number.isFinite(t.workRequired) && t.workRequired > 0) {
            html += renderResearchWorkProgressRow(t.workDone || 0, t.workRequired);
        }
        html += `</div>`;
    }

    html += `</div>`;
    html += `</div>`;
    html += `</div>`;
    return html;
}

function getResearchQueueDepthForStatInGroup(group, kind, key, statKey) {
    if (!Array.isArray(group) || group.length <= 0) return 0;
    return getResearchQueuedDepthForPlayer(group[0].owner, kind, key, statKey);
}

function renderResearchThingRowsForPanel(owner, scope, targetArg) {
    let html = '';
    let scopeKey = getResearchPanelScopeKey(owner, scope);
    let selectedThingId = researchPanelOpenState[scopeKey];
    if (!selectedThingId || !RESEARCH_THINGS_BY_ID[selectedThingId]) {
        let first = RESEARCH_THINGS[0];
        selectedThingId = first ? `${first.kind}:${first.key}` : '';
        researchPanelOpenState[scopeKey] = selectedThingId;
    }

    html += `<div class="info-row" style="display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start">`;
    for (let thing of RESEARCH_THINGS) {
        let thingId = `${thing.kind}:${thing.key}`;
        let isSelected = thingId === selectedThingId;
        let borderRadius = thing.kind === 'unit' ? '50%' : '4px';
        html += `<button class="info-research-thing-btn" data-owner="${owner}" data-scope="${scope}" data-thing-id="${thingId}" title="${thing.label}" style="width:32px;height:32px;padding:0;border:2px solid ${isSelected ? '#8cf' : '#333'};border-radius:${borderRadius};background:${isSelected ? '#1a2730' : '#111'};cursor:pointer;display:flex;align-items:center;justify-content:center">`;
        html += `<img src="${getItemThumbnail(thing.key, 24)}" width="24" height="24" style="display:block;${thing.kind === 'unit' ? 'border-radius:50%;' : ''}">`;
        html += `</button>`;
    }
    html += `</div>`;

    let selectedThing = RESEARCH_THINGS_BY_ID[selectedThingId];
    if (!selectedThing) return html;

    let groupCoordStr = Array.isArray(targetArg) ? targetArg.map(r => `${r.gx},${r.gy}`).join(';') : '';
    html += `<div style="margin-top:4px;border:1px solid #2f2f2f;border-radius:4px;padding:4px;background:#121212">`;
    html += `<div style="font-size:10px;color:#ddd;margin-bottom:3px">${selectedThing.label}</div>`;
    // research building stats drawing
    for (let stat of (selectedThing.stats || [])) {
        let queuedDepth = scope.startsWith('single:')
            ? getResearchQueueDepthForStat(targetArg, selectedThing.kind, selectedThing.key, stat.statKey)
            : getResearchQueueDepthForStatInGroup(targetArg, selectedThing.kind, selectedThing.key, stat.statKey);
        let currentLevel = getPlayerResearchLevel(owner, selectedThing.kind, selectedThing.key, stat.statKey);
        let globalQueuedDepth = getResearchQueuedDepthForPlayer(owner, selectedThing.kind, selectedThing.key, stat.statKey);
        let projectedLevel = currentLevel + globalQueuedDepth;
        let nextCost = getResearchCost(selectedThing.kind, selectedThing.key, stat.statKey, projectedLevel);
        let atMax = projectedLevel >= MAX_RESEARCH_LEVEL;
        let canAfford = !atMax;
        let selectedThingLevel = getResearchPreviewThingLevel();
        let displayFromLevel = currentLevel;
        let displayToLevel = Math.min(MAX_RESEARCH_LEVEL, projectedLevel);
        let currentValue = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, displayFromLevel, selectedThingLevel);
        let projectedValue = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, displayToLevel, selectedThingLevel);
        let baseValue = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, 0, selectedThingLevel);
        // console.log("pre: ", globalQueuedDepth, currentLevel, projectedLevel, displayToLevel, `R${displayToLevel}`)
        if (!Number.isFinite(projectedValue)) projectedValue = currentValue;
        // if (!atMax && displayToLevel <= displayFromLevel) {
        //     displayToLevel = Math.min(MAX_RESEARCH_LEVEL, displayFromLevel + 1);
        //     let nextPreview = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, displayToLevel, selectedThingLevel);
        //     if (Number.isFinite(nextPreview)) projectedValue = nextPreview;
        // }
        // console.log("post: ", globalQueuedDepth, currentLevel, projectedLevel, displayToLevel, `R${displayToLevel}`)
        let projectedMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(projectedValue))
            ? (projectedValue / baseValue)
            : NaN;

        html += `<div style="margin:2px 0 6px 0;padding:3px 4px;border:1px solid #242424;border-radius:4px;background:#101010">`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#bbb"><button type="button" class="info-research-stat-matrix-btn" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" data-from-level="${displayFromLevel}" data-to-level="${displayToLevel}" style="cursor:pointer;background:#111;color:#9cf;border:1px solid #355;border-radius:3px;padding:0 5px;height:18px;line-height:16px;font-size:10px;">M</button><span>${stat.label}</span></span>`;
        html += `<span style="color:#8fc;min-width:54px;text-align:right;display:inline-block;">x${formatResearchMultiplierValue(projectedMultiplier)}</span>`;
        html += `<span style="color:#9cf">Q:${queuedDepth}</span>`;
        html += `</div>`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px">`;
        html += `<span style="color:#fd0">${atMax ? 'MAX' : formatInfoCurrency(nextCost)} <span style="color:#9cf">R${displayToLevel}/${MAX_RESEARCH_LEVEL}</span></span>`;
        if (scope.startsWith('single:')) {
            html += `<div style="display:flex;align-items:center;gap:4px">`;
            html += `<span class="info-research-dequeue-btn" data-gx="${targetArg.gx}" data-gy="${targetArg.gy}" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" style="cursor:pointer;color:#f66;font-weight:bold;">[-]</span>`;
            html += `<span class="info-research-buy-btn" data-gx="${targetArg.gx}" data-gy="${targetArg.gy}" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" style="cursor:${atMax ? 'default' : 'pointer'};color:${canAfford ? '#4f4' : '#242'};font-weight:bold;">[+]</span>`;
            html += `</div>`;
        } else {
            html += `<div style="display:flex;align-items:center;gap:4px">`;
            html += `<span class="info-research-dequeue-group-btn" data-coords="${groupCoordStr}" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" style="cursor:pointer;color:#f66;font-weight:bold;">[-]</span>`;
            html += `<span class="info-research-buy-group-btn" data-coords="${groupCoordStr}" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" style="cursor:${atMax ? 'default' : 'pointer'};color:${canAfford ? '#4f4' : '#242'};font-weight:bold;">[+]</span>`;
            html += `</div>`;
        }
        html += `</div>`;
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}

function renderResearchInfo(e) {
    let html = '';
    let queueScope = `single:${e.gx},${e.gy}`;
    let queueOpen = isResearchQueuePanelOpen(e.owner, queueScope);
    let queueLen = getResearchQueueTotalLength(e);
    let queueCap = getResearchQueueCapacityForPlayer(e.owner);
    let baseVisTiles = getEntityBaseVisibilityRangeTiles(e);
    let effVisTiles = getEntityEffectiveVisibilityRangeTiles(e);
    let baseMaxEnergy = getEntityBaseEnergyMax(e);
    let effMaxEnergy = getEntityEffectiveEnergyMax(e);
    html += infoRow('Energy', formatInfoFraction(Math.floor(e.energy), baseMaxEnergy), formatInfoFraction(Math.floor(e.energy), effMaxEnergy));
    html += infoRow('Status', getEntityStatusText(e, true));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    html += infoRow('Visibility', formatRangeStatTiles(baseVisTiles), formatRangeStatTiles(effVisTiles));
    if (e.owner === localPlayerId) {
        html += infoRow('Rally', e.rallyX !== null ? `(${Math.floor(e.rallyX / TILE)},${Math.floor(e.rallyY / TILE)})` : 'None');
    }
    html += `<div class="info-row info-research-queue-toggle" data-owner="${e.owner}" data-scope="${queueScope}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center">`;
    html += `<span>Queue</span><span>${queueOpen ? '\u25BE' : '\u25B8'} ${formatInfoFraction(queueLen, queueCap)}</span>`;
    html += `</div>`;
    if (e.owner === localPlayerId) {
        let labLevel = getThingEffectiveLevel(e);
        let researcherEnergy = getUnitStatForOwner(e.owner, 'researcher_unit', labLevel, 'energy');
        let researcherQueue = Array.isArray(e.spawnQueue) ? e.spawnQueue : [];
        let queueCount = researcherQueue.length;
        let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
        let totalCost = Math.max(1, Math.floor(Number.isFinite(researcherEnergy) ? researcherEnergy : 1)) * purchaseCount;
        let canQueue = !e.underConstruction;
        let subBtn = canQueue
            ? `<span class="info-dequeue-btn" data-type="worker" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;color:#f66;font-weight:bold;">[-]</span>`
            : `<span style="color:#444;font-weight:bold;">[-]</span>`;
        let addBtn = canQueue
            ? `<span class="info-buy-worker-btn" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;color:#4f4;font-weight:bold;">[+]</span>`
            : `<span style="color:#444;font-weight:bold;">[+]</span>`;
        html += `<div class="info-row" style="align-items:center;justify-content:space-between;gap:8px;">`;
        html += `<span style="color:#fd0;">${formatInfoCurrency(totalCost)}</span>`;
        html += `<span style="color:#fff;margin:0 6px;">${formatInfoFraction(queueCount, 10)}</span>`;
        html += `<span>${subBtn} ${addBtn}</span>`;
        html += `</div>`;
        html += renderSpawnerEnergyProgressRow(getSpawnerEnergyProgress(e));
    }
    if (e.owner === localPlayerId && !e.underConstruction) {
        if (queueOpen) {
            html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
            html += renderQueuedResearchTasksForSingleBuilding(e);
            html += `</div>`;
        }

        html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
        html += `<div style="font-size:10px;color:#8cf;margin-bottom:3px">Shared Research Queue (Per Stat)</div>`;
        html += renderResearchThingRowsForPanel(e.owner, `single:${e.gx},${e.gy}`, e);
        html += `</div>`;
    }
    if (e.owner === localPlayerId) {
        let autoEnabled = isAutoUpgradeEnabled(e);
        let autoBtn = autoUpgradeBtn(e.gx, e.gy, autoEnabled);
        let autoResearchEnabled = isAutoResearchEnabled(e);
        let autoResearchToggle = autoResearchBtn(e.gx, e.gy, autoResearchEnabled);
        let buildBtn = e.underConstruction ? buildToggleBtn(e.gx, e.gy, isBuildEnabled(e)) : disabledInfoPill('\uD83D\uDD28 --');
        let queueBtn = queueToggleBtn(e.gx, e.gy, isQueueEnabled(e));
        let stackBtn = autoStackBtn(e.gx, e.gy, isAutoStackEnabled(e));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;"><span class="info-salvage-btn" data-gx="${e.gx}" data-gy="${e.gy}" style="cursor:pointer;background:${e.markedForSalvage ? '#533' : '#222'};padding:2px 8px;border:1px solid ${e.markedForSalvage ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${e.markedForSalvage ? '#f44' : '#888'}">${e.markedForSalvage ? '\u2620\u2715' : '\u2620'}</span></div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${queueBtn}${stackBtn}${autoResearchToggle}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS.research || 'Runs queued research projects.');
    return html;
}

function renderResearchGroupInfo(group) {
    let html = '';
    let e = group[0];
    let queueScope = `group:${group.map(r => `${r.gx},${r.gy}`).join(';')}`;
    let queueOpen = isResearchQueuePanelOpen(e.owner, queueScope);
    let totalEnergy = 0, totalBaseMaxEnergy = 0, totalEffMaxEnergy = 0;
    let totalBaseVis = 0, totalEffVis = 0;
    for (let r of group) {
        totalEnergy += r.energy;
        totalBaseMaxEnergy += getEntityBaseEnergyMax(r);
        totalEffMaxEnergy += getEntityEffectiveEnergyMax(r);
        totalBaseVis += Number(getEntityBaseVisibilityRangeTiles(r)) || 0;
        totalEffVis += Number(getEntityEffectiveVisibilityRangeTiles(r)) || 0;
    }
    let totalQueue = getResearchQueueTotalLength(e);
    let queueCap = getResearchQueueCapacityForPlayer(e.owner);
    html += infoRow('Count', group.length);
    html += infoRow('Energy', formatInfoFraction(Math.floor(totalEnergy), totalBaseMaxEnergy), formatInfoFraction(Math.floor(totalEnergy), totalEffMaxEnergy));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    let avgBaseVis = group.length > 0 ? totalBaseVis / group.length : 0;
    let avgEffVis = group.length > 0 ? totalEffVis / group.length : 0;
    html += infoRow('Visibility', `${formatRangeStatTiles(avgBaseVis)} avg`, `${formatRangeStatTiles(avgEffVis)} avg`);
    if (e.owner === localPlayerId) {
        let rallyTokens = new Set(group.map(r => (r.rallyX !== null && r.rallyY !== null)
            ? `${Math.floor(r.rallyX / TILE)},${Math.floor(r.rallyY / TILE)}`
            : 'None'));
        if (rallyTokens.size === 1) {
            let token = Array.from(rallyTokens)[0];
            html += infoRow('Rally', token === 'None' ? 'None' : `(${token})`);
        } else {
            html += infoRow('Rally', 'Mixed');
        }
    }
    html += `<div class="info-row info-research-queue-toggle" data-owner="${e.owner}" data-scope="${queueScope}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center">`;
    html += `<span>Queue</span><span>${queueOpen ? '\u25BE' : '\u25B8'} ${formatInfoFraction(totalQueue, queueCap)}</span>`;
    html += `</div>`;
    if (e.owner === localPlayerId) {
        let workerQueueCount = 0;
        for (let r of group) {
            if (!r || !Array.isArray(r.spawnQueue)) continue;
            workerQueueCount += r.spawnQueue.length;
        }
        let readyGroup = group.filter(r => !r.underConstruction);
        let queueReady = readyGroup;
        let workerCoordStr = queueReady.map(r => `${r.gx},${r.gy}`).join(';');
        let queueCostSource = group.find(r => !r.underConstruction) || group[0];
        let cost = queueCostSource ? queueCostSource.getUnitCost() : 0;
        let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
        let totalCost = Math.max(1, Math.floor(cost || 1)) * purchaseCount;
        let canQueue = queueReady.length > 0;
        let subBtn = canQueue
            ? `<span class="info-dequeue-group-btn" data-type="worker" data-coords="${workerCoordStr}" style="cursor:pointer;color:#f66;font-weight:bold;">[-]</span>`
            : `<span style="color:#444;font-weight:bold;">[-]</span>`;
        let addBtn = canQueue
            ? `<span class="info-buy-worker-group-btn" data-coords="${workerCoordStr}" style="cursor:pointer;color:#4f4;font-weight:bold;">[+]</span>`
            : `<span style="color:#444;font-weight:bold;">[+]</span>`;
        html += `<div class="info-row" style="align-items:center;justify-content:space-between;gap:8px;">`;
        html += `<span style="color:#fd0;">${formatInfoCurrency(totalCost)}</span>`;
        html += `<span style="color:#fff;margin:0 6px;">${formatInfoFraction(workerQueueCount, group.length * 10)}</span>`;
        html += `<span>${subBtn} ${addBtn}</span>`;
        html += `</div>`;
        html += renderSpawnerEnergyProgressRow(getSpawnerGroupEnergyProgress(readyGroup));

        if (queueOpen) {
            html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
            html += renderQueuedResearchTasksForGroup(group);
            html += `</div>`;
        }

        html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
        html += `<div style="font-size:10px;color:#8cf;margin-bottom:3px">Shared Research Queue (Per Stat)</div>`;
        html += renderResearchThingRowsForPanel(e.owner, queueScope, group);
        html += `</div>`;

        let coordStr = group.map(r => `${r.gx},${r.gy}`).join(';');
        let anyMarked = group.some(r => r.markedForSalvage);
        let allAutoEnabled = group.every(r => isAutoUpgradeEnabled(r));
        let anyAutoEnabled = group.some(r => isAutoUpgradeEnabled(r));
        let allAutoResearchEnabled = group.every(r => isAutoResearchEnabled(r));
        let anyAutoResearchEnabled = group.some(r => isAutoResearchEnabled(r));
        let hasUnderConstruction = group.some(r => r.underConstruction);
        let allBuildEnabled = group.every(r => isBuildEnabled(r));
        let anyBuildEnabled = group.some(r => isBuildEnabled(r));
        let salvBtn = `<span class="info-salvage-group-btn" data-coords="${coordStr}" style="cursor:pointer;background:${anyMarked ? '#533' : '#222'};padding:2px 8px;border:1px solid ${anyMarked ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${anyMarked ? '#f44' : '#888'}">${anyMarked ? '\u2620\u2715' : '\u2620'}</span>`;
        let autoBtn = autoUpgradeGroupBtn(coordStr, allAutoEnabled, anyAutoEnabled);
        let autoResearch = autoResearchGroupBtn(coordStr, allAutoResearchEnabled, anyAutoResearchEnabled);
        let stackBtn = autoStackGroupBtn(coordStr, group.every(r => isAutoStackEnabled(r)), group.some(r => isAutoStackEnabled(r)));
        let queueBtn = queueToggleGroupBtn(coordStr, group.every(r => isQueueEnabled(r)), group.some(r => isQueueEnabled(r)));
        let buildBtn = hasUnderConstruction ? buildToggleGroupBtn(coordStr, allBuildEnabled, anyBuildEnabled) : disabledInfoPill('\uD83D\uDD28 --');
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;">${salvBtn}</div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${queueBtn}${stackBtn}${autoResearch}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS.research || 'Runs queued research projects.');
    return html;
}

function bindResearchPopupControls(container) {
    if (!container || container.dataset.boundResearchPopup === '1') return;
    container.dataset.boundResearchPopup = '1';

    let parseCoords = (coordStr) => (coordStr || '').split(';').map(c => {
        let [x, y] = c.split(',');
        return { gx: parseInt(x), gy: parseInt(y) };
    }).filter(c => Number.isFinite(c.gx) && Number.isFinite(c.gy));

    let queueAndRefresh = (action) => {
        queueAction(action);
        updateInfoPanel();
        if (!researchQueueDragInProgress) renderResearchPopupContent();
    };

    container.addEventListener('click', (e) => {
        let target = e.target;
        if (!(target instanceof Element)) return;
        let btn = target.closest('[class*="info-"]');
        if (!btn) return;

        if (btn.classList.contains('info-research-level-preview-btn')) {
            let kind = btn.dataset.kind;
            let key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            let fromLevel = Number.parseInt(btn.dataset.fromLevel, 10);
            let toLevel = Number.parseInt(btn.dataset.toLevel, 10);
            openResearchThingLevelDropdown(btn, { kind, key, statKey, fromLevel, toLevel });
            return;
        }

        if (btn.classList.contains('info-research-stat-matrix-btn')) {
            let kind = btn.dataset.kind;
            let key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            let fromLevel = Number.parseInt(btn.dataset.fromLevel, 10);
            let toLevel = Number.parseInt(btn.dataset.toLevel, 10);
            openResearchStatMatrixPopup(kind, key, statKey, fromLevel, toLevel);
            return;
        }

        if (btn.classList.contains('info-research-buy-btn')) {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let kind = btn.dataset.kind, key = btn.dataset.key, statKey = btn.dataset.statKey;
            queueAndRefresh({ action: 'queueResearch', gx, gy, kind, key, statKey, count: queuePurchaseMultiplier });
            return;
        }

        if (btn.classList.contains('info-research-buy-group-btn')) {
            let kind = btn.dataset.kind, key = btn.dataset.key, statKey = btn.dataset.statKey;
            let coords = parseCoords(btn.dataset.coords);
            let anchor = coords.find(c => {
                let v = getSpawnerAtTile(c.gx, c.gy);
                return !!(v && v.owner === localPlayerId && v.energy > 0 && !v.underConstruction && v.type === 'research');
            });
            if (!anchor) return;
            queueAndRefresh({ action: 'queueResearch', gx: anchor.gx, gy: anchor.gy, kind, key, statKey, count: queuePurchaseMultiplier });
            return;
        }

        if (btn.classList.contains('info-research-dequeue-btn')) {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let kind = btn.dataset.kind, key = btn.dataset.key, statKey = btn.dataset.statKey;
            queueAndRefresh({ action: 'dequeueResearch', gx, gy, kind, key, statKey, count: queuePurchaseMultiplier });
            return;
        }

        if (btn.classList.contains('info-research-dequeue-group-btn')) {
            let kind = btn.dataset.kind, key = btn.dataset.key, statKey = btn.dataset.statKey;
            let coords = parseCoords(btn.dataset.coords);
            let anchor = coords.find(c => {
                let v = getSpawnerAtTile(c.gx, c.gy);
                return !!(v && v.owner === localPlayerId && v.energy > 0 && !v.underConstruction && v.type === 'research');
            });
            if (!anchor) return;
            queueAndRefresh({ action: 'dequeueResearch', gx: anchor.gx, gy: anchor.gy, kind, key, statKey, count: queuePurchaseMultiplier });
            return;
        }

        if (btn.classList.contains('info-research-thing-btn')) {
            let owner = Number.parseInt(btn.dataset.owner);
            let scope = btn.dataset.scope;
            let thingId = btn.dataset.thingId;
            if (!Number.isFinite(owner) || !scope || !thingId) return;
            researchPanelOpenState[getResearchPanelScopeKey(owner, scope)] = thingId;
            renderResearchPopupContent();
            return;
        }

        if (btn.classList.contains('info-research-queue-toggle')) {
            let owner = Number.parseInt(btn.dataset.owner);
            let scope = btn.dataset.scope;
            if (!Number.isFinite(owner) || !scope) return;
            let key = getResearchPanelScopeKey(owner, scope);
            researchQueuePanelOpenState[key] = !researchQueuePanelOpenState[key];
            renderResearchPopupContent();
            return;
        }

        if (btn.classList.contains('info-auto-research-btn')) {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let enabled = btn.dataset.enabled === '1';
            queueAndRefresh({ action: 'setAutoResearch', gx, gy, enabled });
            return;
        }

        if (btn.classList.contains('info-auto-research-group-btn')) {
            let enabled = btn.dataset.enabled === '1';
            let coords = parseCoords(btn.dataset.coords);
            for (let c of coords) queueAction({ action: 'setAutoResearch', gx: c.gx, gy: c.gy, enabled });
            updateInfoPanel();
            renderResearchPopupContent();
            return;
        }
    });
}

function renderFloorItemGroupInfo(group) {
    let html = '';
    let e = group[0];
    let def = BASE_CARD_TYPES[e.type];
    let baseStacks = e.stacks || 1;
    let baseLevel = stackCountToLevel(baseStacks);
    let effStacks = e.effectiveStacks || baseStacks;
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    let totalBaseVis = 0;
    let totalEffVis = 0;
    let baseStats = calculateItemStats(e.type, baseLevel, e.owner);
    let effStats = calculateItemStats(e.type, effLevel, e.owner);
    let totalEnergy = 0, totalBaseMaxEnergy = 0, totalEffMaxEnergy = 0;
    for (let f of group) {
        totalEnergy += (f.energy || 0);
        totalBaseMaxEnergy += getEntityBaseEnergyMax(f);
        totalEffMaxEnergy += getEntityEffectiveEnergyMax(f);
        totalBaseVis += Number(getEntityBaseVisibilityRangeTiles(f)) || 0;
        totalEffVis += Number(getEntityEffectiveVisibilityRangeTiles(f)) || 0;
    }
    html += infoRow('Count', group.length);
    if (baseStats.maxEnergy > 0) html += infoRow('Energy', formatInfoFraction(Math.floor(totalEnergy), totalBaseMaxEnergy), formatInfoFraction(Math.floor(totalEnergy), totalEffMaxEnergy));
    html += infoRowLevel('Level', e);
    html += infoRowStacks(baseStacks, baseLevel, effStacks, effLevel, getThingManualStacks(e));
    let avgBaseVis = group.length > 0 ? totalBaseVis / group.length : 0;
    let avgEffVis = group.length > 0 ? totalEffVis / group.length : 0;
    html += infoRow('Visibility', `${formatRangeStatTiles(avgBaseVis)} avg`, `${formatRangeStatTiles(avgEffVis)} avg`);
    if (effStats.damage > 0) {
        let baseDmg = baseStats.damage, effDmg = effStats.damage;
        if (e.type === 'mine') html += infoRow('Explode Dmg', Math.floor(baseDmg), baseDmg !== effDmg ? Math.floor(effDmg) : undefined);
        else if (e.type === 'lava') {
            let baseBurnDps = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'burnDps');
            let effBurnDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'burnDps');
            let baseBurnDur = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'burnDuration');
            let effBurnDur = getBuildingStatForOwner(e.owner, e.type, effLevel, 'burnDuration');
            html += infoRow('Burn DPS', `${((Number.isFinite(baseBurnDps) ? baseBurnDps : baseDmg) * TICK_RATE).toFixed(2)}/s`, Number.isFinite(effBurnDps) && Math.abs((baseBurnDps || 0) - effBurnDps) > 1e-6 ? `${(effBurnDps * TICK_RATE).toFixed(2)}/s` : undefined);
            if (Number.isFinite(baseBurnDur) || Number.isFinite(effBurnDur)) html += infoRow('Burn Duration', `${(Number.isFinite(baseBurnDur) ? baseBurnDur : 0).toFixed(1)}s`, Number.isFinite(effBurnDur) && baseBurnDur !== effBurnDur ? `${effBurnDur.toFixed(1)}s` : undefined);
        }
        else if (e.type === 'poison_puddle') {
            let basePoisonDps = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'poisonDps');
            let effPoisonDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'poisonDps');
            let basePoisonDur = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'poisonDuration');
            let effPoisonDur = getBuildingStatForOwner(e.owner, e.type, effLevel, 'poisonDuration');
            html += infoRow('Poison DPS', `${((Number.isFinite(basePoisonDps) ? basePoisonDps : baseDmg) * TICK_RATE).toFixed(2)}/s`, Number.isFinite(effPoisonDps) && Math.abs((basePoisonDps || 0) - effPoisonDps) > 1e-6 ? `${(effPoisonDps * TICK_RATE).toFixed(2)}/s` : undefined);
            if (Number.isFinite(basePoisonDur) || Number.isFinite(effPoisonDur)) html += infoRow('Poison Duration', `${(Number.isFinite(basePoisonDur) ? basePoisonDur : 0).toFixed(1)}s`, Number.isFinite(effPoisonDur) && basePoisonDur !== effPoisonDur ? `${effPoisonDur.toFixed(1)}s` : undefined);
        }
        else if (e.type === 'ice_patch') {
            let baseFreezeDps = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'freezeDps');
            let effFreezeDps = getBuildingStatForOwner(e.owner, e.type, effLevel, 'freezeDps');
            let baseFreezeDur = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'freezeDuration');
            let effFreezeDur = getBuildingStatForOwner(e.owner, e.type, effLevel, 'freezeDuration');
            html += infoRow('Freeze DPS', `${((Number.isFinite(baseFreezeDps) ? baseFreezeDps : baseDmg) * TICK_RATE).toFixed(2)}/s`, Number.isFinite(effFreezeDps) && Math.abs((baseFreezeDps || 0) - effFreezeDps) > 1e-6 ? `${(effFreezeDps * TICK_RATE).toFixed(2)}/s` : undefined);
            if (Number.isFinite(baseFreezeDur) || Number.isFinite(effFreezeDur)) html += infoRow('Freeze Duration', `${(Number.isFinite(baseFreezeDur) ? baseFreezeDur : 0).toFixed(1)}s`, Number.isFinite(effFreezeDur) && baseFreezeDur !== effFreezeDur ? `${effFreezeDur.toFixed(1)}s` : undefined);
        }
        else html += infoRow('Damage', baseDmg.toFixed(2), baseDmg !== effDmg ? effDmg.toFixed(2) : undefined);
    }
    if (e.type === 'sand') html += infoRow('Effect', '50% slow');
    if (e.type === 'ice_patch') html += infoRow('Effect', '50% slow + freeze');
    if (e.type === 'water_puddle') html += infoRow('Effect', 'Soak (ice combo)');
    if (e.type === 'farm') {
        let baseInc = getBuildingStatForOwner(e.owner, 'farm', baseLevel, 'multiplier');
        let effInc = getBuildingStatForOwner(e.owner, 'farm', effLevel, 'multiplier');
        if (!Number.isFinite(baseInc)) baseInc = Math.max(1, baseLevel);
        if (!Number.isFinite(effInc)) effInc = Math.max(1, effLevel);
        html += infoRow('Multiplier', `${baseInc.toFixed(2)}x gather`, Math.abs(baseInc - effInc) > 1e-6 ? `${effInc.toFixed(2)}x gather` : undefined);
    }
    if (e.type === 'house') {
        let totalBasePopCap = 0;
        let totalEffPopCap = 0;
        for (let h of group) {
            let hBaseLevel = stackCountToLevel(h.stacks || 1);
            let hEffLevel = getThingEffectiveLevel(h, hBaseLevel);
            let hBasePop = getBuildingStatForOwner(h.owner, 'house', hBaseLevel, 'popCap');
            let hEffPop = getBuildingStatForOwner(h.owner, 'house', hEffLevel, 'popCap');
            if (!Number.isFinite(hBasePop)) hBasePop = getHousePopCapContribution(h.owner, hBaseLevel);
            if (!Number.isFinite(hEffPop)) hEffPop = getHousePopCapContribution(h.owner, hEffLevel);
            totalBasePopCap += Math.max(1, Math.floor(hBasePop));
            totalEffPopCap += Math.max(1, Math.floor(hEffPop));
        }
        html += infoRow('Pop Cap', `+${formatBigNumber(totalBasePopCap)}`, totalBasePopCap !== totalEffPopCap ? `+${formatBigNumber(totalEffPopCap)}` : undefined);
    }
    html += infoRow('Value', `⚡${formatBigNumber(def.price || '?')}`);
    if (e._gx !== undefined || e.gx !== undefined) {
        let anyMarked = group.some(f => f.markedForSalvage);
        let allAutoEnabled = group.every(f => isAutoUpgradeEnabled(f));
        let anyAutoEnabled = group.some(f => isAutoUpgradeEnabled(f));
        let hasUnderConstruction = group.some(f => f.underConstruction);
        let allBuildEnabled = group.every(f => isBuildEnabled(f));
        let anyBuildEnabled = group.some(f => isBuildEnabled(f));
        let coordStr = group.map(f => { let gx = f.gx !== undefined ? f.gx : f._gx, gy = f.gy !== undefined ? f.gy : f._gy; return `${gx},${gy}`; }).join(';');
        let autoBtn = autoUpgradeGroupBtn(coordStr, allAutoEnabled, anyAutoEnabled);
        let buildBtn = hasUnderConstruction ? buildToggleGroupBtn(coordStr, allBuildEnabled, anyBuildEnabled) : '';
        let stackBtn = autoStackGroupBtn(coordStr, group.every(f => isAutoStackEnabled(f)), group.some(f => isAutoStackEnabled(f)));
        html += `<div class="info-row" style="justify-content:space-between;align-items:center;gap:6px;"><div style="display:flex;align-items:center;"><span class="info-salvage-group-btn" data-coords="${coordStr}" style="cursor:pointer;background:${anyMarked ? '#533' : '#222'};padding:2px 8px;border:1px solid ${anyMarked ? '#f44' : '#555'};border-radius:3px;font-size:9px;color:${anyMarked ? '#f44' : '#888'}">${anyMarked ? '\u2620\u2715' : '\u2620'}</span></div><div style="display:flex;align-items:center;gap:4px;">${buildBtn}${stackBtn}${autoBtn}</div></div>`;
    }
    html += infoDesc(DESCRIPTIONS[e.type] || 'Placed floor item.');
    return html;
}

function updateInfoPanel(panelOverride = null, opts = {}) {
    let panel = panelOverride || document.getElementById('info-panel');
    if (!panel) return;
    let prevFormatBigNumberSuffixStart = activeFormatBigNumberSuffixStart;
    activeFormatBigNumberSuffixStart = panelOverride ? 1000000 : 1000;
    let skipGlobalSync = !!opts.skipGlobalSync;
    let subgroupState = (opts && opts.subgroupState && typeof opts.subgroupState === 'object') ? opts.subgroupState : activeSubGroups;
    let refreshThisPanel = () => {
        if (typeof opts.onRefresh === 'function') {
            opts.onRefresh();
            return;
        }
        if (panelOverride) updateInfoPanel(panel, opts);
        else updateInfoPanel();
    };
    let commitSubgroupState = () => {
        if (typeof opts.onSubgroupStateChange === 'function') opts.onSubgroupStateChange(subgroupState);
    };
    if (!skipGlobalSync) {
        updateIgnoreLevelButton();
        updateControlGroupBar();
    }

    // Remove dead entities
    selectedEntities = selectedEntities.filter(e => !(e.energy !== undefined && e.energy <= 0));
    selectedUnits = selectedUnits.filter(u => !u.dead);

    let totalSel = selectedEntities.length + selectedUnits.length;
    if (totalSel === 0) {
        let playerStatusHtml = buildInfoPanelPlayerStatusHtml();
        if (playerStatusHtml) {
            panel.style.display = 'block';
            panel.innerHTML = playerStatusHtml;
            bindInfoPanelPlayerStatusControls(panel);
        } else {
            panel.style.display = 'none';
            panel.innerHTML = '';
        }
        activeFormatBigNumberSuffixStart = prevFormatBigNumberSuffixStart;
        return;
    }
    panel.style.display = 'block';
    bindInfoPanelInteractionTracking(panel);

    infoPanelStatMatrixDescriptorById = {};
    nextInfoPanelStatMatrixDescriptorId = 1;
    let panelMouseAnchor = captureInfoPanelMouseAnchor(panel);

    let html = '';
    // --- GROUP ENTITIES by key ---
    let entityGroups = {};
    for (let e of selectedEntities) {
        let key = getEntityGroupKey(e);
        if (!entityGroups[key]) entityGroups[key] = { label: getEntityGroupLabel(e), items: [], isEntity: true };
        entityGroups[key].items.push(e);
    }
    // Group units by type
    let unitGroups = {};
    for (let u of selectedUnits) {
        let key = getUnitGroupKey(u);
        if (!unitGroups[key]) unitGroups[key] = { label: u.unitType.toUpperCase(), items: [], isUnit: true };
        unitGroups[key].items.push(u);
    }

    let allGroups = [...Object.entries(entityGroups), ...Object.entries(unitGroups)];
    let showSubGroupToggles = allGroups.length > 0;

    // Ensure all groups have an explicit entry (default true)
    for (let [k] of allGroups) {
        if (subgroupState[k] === undefined) subgroupState[k] = true;
    }

    // --- SUB-GROUP ICON TOGGLE BAR ---
    if (showSubGroupToggles) {
        html += `<div id="subgroup-bar" style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px;align-items:flex-end">`;
        for (let [key, grp] of allGroups) {
            let isActive = subgroupState[key] !== false;
            let borderColor = isActive ? getGroupBorderColor(grp) : '#333';
            let opacity = isActive ? '1' : '0.35';
            let lvl = getGroupLevel(key, grp);
            let thumbKey = getGroupThumbKey(grp);
            let iconRadius = grp.isUnit ? '50%' : '3px';
            let iconClass = grp.isUnit ? 'sg-icon-box sg-unit' : 'sg-icon-box sg-entity';
            let lvlPos = grp.isUnit ? 'left:50%;transform:translateX(-50%);' : 'left:1px;';
            let countPos = grp.isUnit ? 'left:50%;transform:translateX(-50%);' : 'right:1px;';
            html += `<div class="subgroup-toggle" data-key="${key}" data-thumb="${thumbKey || ''}" style="cursor:pointer;opacity:${opacity};width:36px;text-align:center;position:relative">`;
            html += `<div class="${iconClass}" style="width:34px;height:34px;border:2px solid ${borderColor};border-radius:${iconRadius};background:#111;display:flex;align-items:center;justify-content:center;position:relative">`;
            if (lvl !== null) html += `<span style="position:absolute;top:-1px;${lvlPos}font-size:7px;color:#aaa;z-index:1">L${lvl}</span>`;
            html += `<span style="position:absolute;bottom:-1px;${countPos}font-size:8px;color:#fd0;font-weight:bold;z-index:1">x${grp.items.length}</span>`;
            html += `</div></div>`;
        }
        // Select All / Deselect All
        html += `<div style="display:flex;flex-direction:column;gap:1px;margin-left:auto">`;
        html += `<span class="subgroup-all" data-action="all" style="cursor:pointer;font-size:8px;color:#4f4;padding:1px 4px;border:1px solid #333;border-radius:2px;background:#1a1a1a">All</span>`;
        html += `<span class="subgroup-all" data-action="none" style="cursor:pointer;font-size:8px;color:#f44;padding:1px 4px;border:1px solid #333;border-radius:2px;background:#1a1a1a">None</span>`;
        html += `</div>`;
        html += `</div>`;
        html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    }

    // --- SUMMARY HEADER ---
    if (totalSel > 1) {
        let totalEnergy = 0, totalmaxEnergy = 0;
        for (let e of selectedEntities) { if (e.energy !== undefined) { totalEnergy += e.energy; totalmaxEnergy += e.maxEnergy; } }
        for (let u of selectedUnits) { totalEnergy += u.energy; totalmaxEnergy += u.maxEnergy; }
        html += `<div class="info-title">${totalSel} selected</div>`;
        html += infoRow('Total Energy', `${Math.floor(totalEnergy)}/${Math.floor(totalmaxEnergy)}`);
        html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    }

    // --- INDIVIDUAL GROUP SECTIONS (only show active groups) ---
    let activeGroupCount = 0;
    for (let [key, grp] of allGroups) {
        if (subgroupState[key] === false) continue;
        activeGroupCount++;

        let items = grp.items;
        let label = grp.label;
        let subgroupPopupBtnHtml = `<button type="button" class="info-subgroup-research-btn" data-key="${key}" title="Open research popup for this subgroup" style="cursor:pointer;background:#1a2631;color:#cfe6ff;border:1px solid #486179;border-radius:3px;font-size:10px;padding:0 4px;margin-right:4px;line-height:1.2">P</button>`;

        if (grp.isUnit) {
            let u0 = items[0];
            let prefix = items.length > 1 ? `${items.length}x ` : '';
            let mixedUnitLevels = false;
            let mixedEffectiveLevels = false;
            if (items.length > 1) {
                let unitLevels = new Set(items.map(u => getUnitBaseLevel(u)));
                let effectiveLevels = new Set(items.map(u => getUnitEffectiveLevel(u)));
                mixedUnitLevels = unitLevels.size > 1;
                mixedEffectiveLevels = effectiveLevels.size > 1;
            }
            html += infoHeaderUnit(prefix + label, u0, { mixedLevel: mixedUnitLevels || mixedEffectiveLevels, leftButtonHtml: subgroupPopupBtnHtml });
            if (items.length === 1) {
                html += runWithInfoPanelStatMatrixContext(getInfoPanelMatrixContextForUnit(items[0]), () => renderUnitInfo(items[0]));
            } else {
                html += runWithInfoPanelStatMatrixContext(getInfoPanelMatrixContextForUnit(items[0]), () => renderUnitGroupInfo(items));
            }
        } else {
            let e0 = items[0];
            let prefix = items.length > 1 ? `${items.length}x ` : '';
            if (e0._isGoldMine || e0._isAstarMine) {
                html += `<div class="info-title">${subgroupPopupBtnHtml}${prefix}${label}</div>`;
            } else {
                let mixedEntityLevels = false;
                if (items.length > 1) {
                    let levelTokens = new Set(items.map(it => getEntityLevelToken(it)));
                    mixedEntityLevels = levelTokens.size > 1;
                }
                html += infoHeader(prefix + label, e0, { mixedLevel: mixedEntityLevels, leftButtonHtml: subgroupPopupBtnHtml });
            }
            if (items.length === 1) {
                html += renderEntityBlock(items[0]);
            } else {
                html += renderEntityGroupBlock(items);
            }
        }
        html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    }

    if (activeGroupCount === 0) {
        let playerStatusHtml = buildInfoPanelPlayerStatusHtml();
        if (playerStatusHtml) {
            html += `<div style="margin-top:4px">${playerStatusHtml}</div>`;
        }
    }

    panel.innerHTML = html;
    bindInfoPanelPlayerStatusControls(panel);

    // Insert thumbnails into sub-group toggle icons
    panel.querySelectorAll('.subgroup-toggle[data-thumb]').forEach(el => {
        let thumbKey = el.dataset.thumb;
        if (!thumbKey) return;
        let box = el.querySelector('.sg-icon-box');
        if (box) {
            let thumbUrl = getItemThumbnail(thumbKey, 26);
            let img = document.createElement('img');
            img.src = thumbUrl; img.width = 26; img.height = 26;
            if (box.classList.contains('sg-unit')) img.style.borderRadius = '50%';
            box.insertBefore(img, box.firstChild);
        }
    });

    // Wire up buy buttons for single barracks
    panel.querySelectorAll('.info-buy-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            queueAction({ action: 'queueUnit', gx, gy, count: queuePurchaseMultiplier });
        });
    });
    // Wire up group buy buttons - dynamically find barrack with lowest queue
    panel.querySelectorAll('.info-buy-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let parseCoords = (coordStr) => (coordStr || '').split(';').map(c => {
                let [x, y] = c.split(',');
                return { gx: parseInt(x), gy: parseInt(y) };
            }).filter(c => Number.isFinite(c.gx) && Number.isFinite(c.gy));
            let coords = parseCoords(btn.dataset.coords);
            let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
            let options = coords.map(c => {
                let b = getBarrackAtTile(c.gx, c.gy);
                if (!(b && b.owner === localPlayerId && b.energy > 0 && !b.underConstruction)) b = null;
                return b ? { gx: b.gx, gy: b.gy, len: b.spawnQueue.length } : null;
            }).filter(Boolean);
            for (let i = 0; i < purchaseCount; i++) {
                let best = null;
                for (let o of options) {
                    if (o.len >= 20) continue;
                    if (!best || o.len < best.len) best = o;
                }
                if (!best) return;
                queueAction({ action: 'queueUnit', gx: best.gx, gy: best.gy, count: 1 });
                best.len++;
            }
        });
    });

    // Wire up worker buy buttons (single spawner)
    panel.querySelectorAll('.info-buy-worker-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            queueAction({ action: 'queueWorker', gx, gy, count: queuePurchaseMultiplier });
        });
    });
    // Wire up worker group buy buttons - distribute to lowest queue
    panel.querySelectorAll('.info-buy-worker-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let parseCoords = (coordStr) => (coordStr || '').split(';').map(c => {
                let [x, y] = c.split(',');
                return { gx: parseInt(x), gy: parseInt(y) };
            }).filter(c => Number.isFinite(c.gx) && Number.isFinite(c.gy));
            let coords = parseCoords(btn.dataset.coords);
            let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
            let options = coords.map(c => {
                let s = getSpawnerAtTile(c.gx, c.gy);
                if (!(s && s.owner === localPlayerId && s.energy > 0 && !s.underConstruction)) s = null;
                return s ? { gx: s.gx, gy: s.gy, len: (s.spawnQueue || []).length } : null;
            }).filter(Boolean);
            for (let i = 0; i < purchaseCount; i++) {
                let best = null;
                for (let o of options) {
                    if (o.len >= 10) continue;
                    if (!best || o.len < best.len) best = o;
                }
                if (!best) return;
                queueAction({ action: 'queueWorker', gx: best.gx, gy: best.gy, count: 1 });
                best.len++;
            }
        });
    });

    // Wire up research buy buttons (single research building)
    panel.querySelectorAll('.info-research-buy-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let kind = btn.dataset.kind, key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            queueAction({ action: 'queueResearch', gx, gy, kind, key, statKey, count: queuePurchaseMultiplier });
        });
    });

    // Wire up research buy buttons (group scope, shared queue)
    panel.querySelectorAll('.info-research-buy-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let kind = btn.dataset.kind, key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            let coords = (btn.dataset.coords || '').split(';').map(c => {
                let [x, y] = c.split(',');
                return { gx: parseInt(x), gy: parseInt(y) };
            }).filter(c => Number.isFinite(c.gx) && Number.isFinite(c.gy));
            let anchor = coords.find(c => {
                let v = getSpawnerAtTile(c.gx, c.gy);
                return !!(v && v.owner === localPlayerId && v.energy > 0 && !v.underConstruction && v.type === 'research');
            });
            if (!anchor) return;
            let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
            queueAction({ action: 'queueResearch', gx: anchor.gx, gy: anchor.gy, kind, key, statKey, count: purchaseCount });
        });
    });

    // Wire up research dequeue buttons (single)
    panel.querySelectorAll('.info-research-dequeue-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let kind = btn.dataset.kind, key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            queueAction({ action: 'dequeueResearch', gx, gy, kind, key, statKey, count: queuePurchaseMultiplier });
        });
    });

    // Wire up research dequeue buttons (group scope, shared queue)
    panel.querySelectorAll('.info-research-dequeue-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let kind = btn.dataset.kind, key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            let coords = (btn.dataset.coords || '').split(';').map(c => {
                let [x, y] = c.split(',');
                return { gx: parseInt(x), gy: parseInt(y) };
            }).filter(c => Number.isFinite(c.gx) && Number.isFinite(c.gy));
            let anchor = coords.find(c => {
                let v = getSpawnerAtTile(c.gx, c.gy);
                return !!(v && v.owner === localPlayerId && v.energy > 0 && !v.underConstruction && v.type === 'research');
            });
            if (!anchor) return;
            let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
            queueAction({ action: 'dequeueResearch', gx: anchor.gx, gy: anchor.gy, kind, key, statKey, count: purchaseCount });
        });
    });

    // Wire up clickable research value previews (x->y) for thing-level dropdown.
    panel.querySelectorAll('.info-research-level-preview-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let kind = btn.dataset.kind;
            let key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            let fromLevel = Number.parseInt(btn.dataset.fromLevel, 10);
            let toLevel = Number.parseInt(btn.dataset.toLevel, 10);
            openResearchThingLevelDropdown(btn, { kind, key, statKey, fromLevel, toLevel });
        });
    });

    panel.querySelectorAll('.info-research-stat-matrix-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let kind = btn.dataset.kind;
            let key = btn.dataset.key;
            let statKey = btn.dataset.statKey;
            let fromLevel = Number.parseInt(btn.dataset.fromLevel, 10);
            let toLevel = Number.parseInt(btn.dataset.toLevel, 10);
            openResearchStatMatrixPopup(kind, key, statKey, fromLevel, toLevel);
        });
    });

    panel.querySelectorAll('.info-stat-matrix-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let matrixId = Number.parseInt(btn.dataset.matrixId || '', 10);
            if (!Number.isFinite(matrixId)) return;
            researchStatMatrixPopupPayload = { infoPanelMatrixId: matrixId };
            setResearchStatMatrixPopupOpen(true);
        });
    });

    restoreInfoPanelMouseAnchor(panel, panelMouseAnchor);

    panel.querySelectorAll('.info-research-move-top-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = Number.parseInt(btn.dataset.gx, 10);
            let gy = Number.parseInt(btn.dataset.gy, 10);
            let owner = Number.parseInt(btn.dataset.owner, 10);
            let fromIndex = Math.floor(Number(btn.dataset.pendingIndex));
            let fromActive = btn.dataset.active === '1';
            if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(owner)) return;
            if (!Number.isFinite(fromIndex)) return;
            if (fromActive) return;
            let queueLen = getPlayerResearchQueue(owner).length;
            if (fromIndex < 0 || fromIndex >= queueLen) return;
            queueAction({ action: 'reorderResearch', gx, gy, fromIndex, toIndex: 0, fromActive: false, toActive: false });
            refreshThisPanel();
        });
    });

    panel.querySelectorAll('.info-research-move-bottom-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = Number.parseInt(btn.dataset.gx, 10);
            let gy = Number.parseInt(btn.dataset.gy, 10);
            let owner = Number.parseInt(btn.dataset.owner, 10);
            let fromIndex = Math.floor(Number(btn.dataset.pendingIndex));
            let fromActive = btn.dataset.active === '1';
            if (!Number.isFinite(gx) || !Number.isFinite(gy) || !Number.isFinite(owner)) return;
            if (!Number.isFinite(fromIndex)) return;
            let queueLen = getPlayerResearchQueue(owner).length;
            if (queueLen <= 0) return;
            let toIndex = queueLen - 1;
            if (!fromActive && (fromIndex < 0 || fromIndex >= queueLen)) return;
            if (!fromActive && fromIndex === toIndex) return;
            queueAction({ action: 'reorderResearch', gx, gy, fromIndex, toIndex, fromActive, toActive: false });
            refreshThisPanel();
        });
    });

    panel.querySelectorAll('.info-research-thing-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let owner = Number.parseInt(btn.dataset.owner);
            let scope = btn.dataset.scope;
            let thingId = btn.dataset.thingId;
            if (!Number.isFinite(owner) || !scope || !thingId) return;
            researchPanelOpenState[getResearchPanelScopeKey(owner, scope)] = thingId;
            refreshThisPanel();
        });
    });

    panel.querySelectorAll('.info-research-queue-toggle').forEach(btn => {
        bindInstantPress(btn, () => {
            let owner = Number.parseInt(btn.dataset.owner);
            let scope = btn.dataset.scope;
            if (!Number.isFinite(owner) || !scope) return;
            let key = getResearchPanelScopeKey(owner, scope);
            researchQueuePanelOpenState[key] = !researchQueuePanelOpenState[key];
            refreshThisPanel();
        });
    });

    // Wire up dequeue buttons
    panel.querySelectorAll('.info-dequeue-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let type = btn.dataset.type === 'unit' ? 'dequeueUnit' : 'dequeueWorker';
            queueAction({ action: type, gx, gy, count: queuePurchaseMultiplier });
        });
    });

    // Wire up dequeue group buttons (removes from building with highest queue)
    panel.querySelectorAll('.info-dequeue-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let coords = (btn.dataset.coords || '').split(';').map(c => {
                let [x, y] = c.split(',');
                return { gx: parseInt(x), gy: parseInt(y) };
            }).filter(c => Number.isFinite(c.gx) && Number.isFinite(c.gy));
            let isWorker = btn.dataset.type === 'worker';
            let purchaseCount = Math.max(1, Math.floor(queuePurchaseMultiplier || 1));
            let options = coords.map(c => {
                if (isWorker) {
                    let s = getSpawnerAtTile(c.gx, c.gy);
                    if (!(s && s.owner === localPlayerId && s.energy > 0 && !s.underConstruction)) s = null;
                    return s ? { gx: s.gx, gy: s.gy, len: (s.spawnQueue || []).length } : null;
                }
                let b = getBarrackAtTile(c.gx, c.gy);
                if (!(b && b.owner === localPlayerId && b.energy > 0 && !b.underConstruction)) b = null;
                return b ? { gx: b.gx, gy: b.gy, len: b.spawnQueue.length } : null;
            }).filter(Boolean);
            for (let i = 0; i < purchaseCount; i++) {
                let best = null;
                for (let o of options) {
                    if (o.len <= 0) continue;
                    if (!best || o.len > best.len) best = o;
                }
                if (!best) return;
                queueAction({ action: isWorker ? 'dequeueWorker' : 'dequeueUnit', gx: best.gx, gy: best.gy, count: 1 });
                best.len--;
            }
        });
    });

    // Wire up sub-group toggle buttons (simple toggle, doesn't affect others)
    panel.querySelectorAll('.subgroup-toggle').forEach(btn => {
        bindInstantPress(btn, () => {
            let key = btn.dataset.key;
            subgroupState[key] = !subgroupState[key];
            commitSubgroupState();
            refreshThisPanel();
        });
    });

    // Wire up select all / deselect all
    panel.querySelectorAll('.subgroup-all').forEach(btn => {
        bindInstantPress(btn, () => {
            let val = btn.dataset.action === 'all';
            for (let [k] of allGroups) subgroupState[k] = val;
            commitSubgroupState();
            refreshThisPanel();
        });
    });

    // Open research popup with only this subgroup, equivalent to assigning only
    // this subgroup to a popup control group and opening that popup group.
    panel.querySelectorAll('.info-subgroup-research-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let key = btn.dataset.key;
            if (!key) return;
            let pair = allGroups.find(([groupKey]) => groupKey === key);
            if (!pair || !pair[1] || !Array.isArray(pair[1].items)) return;
            let grp = pair[1];
            let popupKey = '__single_subgroup_popup__';
            popupControlGroups[popupKey] = {
                units: grp.isUnit ? grp.items.filter(u => u && !u.dead) : [],
                entities: grp.isUnit ? [] : grp.items.filter(e => e && !(e.energy !== undefined && e.energy <= 0)),
                activeSubGroups: {}
            };
            activePopupControlGroupKey = popupKey;
            setResearchPopupOpen(true);
        });
    });
    // Wire up salvage buttons (single building)
    panel.querySelectorAll('.info-salvage-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            if (btn.dataset.unitId) {
                queueAction({ action: 'killUnit', unitId: parseInt(btn.dataset.unitId) });
            } else {
                let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
                queueAction({ action: 'markSalvage', gx, gy });
            }
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up salvage group buttons
    panel.querySelectorAll('.info-salvage-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let coords = btn.dataset.coords.split(';').map(c => { let [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; });
            for (let c of coords) queueAction({ action: 'markSalvage', gx: c.gx, gy: c.gy });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up auto-upgrade toggles (single barrack)
    panel.querySelectorAll('.info-auto-upgrade-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let enabled = btn.dataset.enabled === '1';
            queueAction({ action: 'setAutoUpgrade', gx, gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up auto-upgrade toggles (barrack groups)
    panel.querySelectorAll('.info-auto-upgrade-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let enabled = btn.dataset.enabled === '1';
            let coords = btn.dataset.coords.split(';').map(c => { let [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; });
            for (let c of coords) queueAction({ action: 'setAutoUpgrade', gx: c.gx, gy: c.gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up auto-stack toggles (single)
    panel.querySelectorAll('.info-auto-stack-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let enabled = btn.dataset.enabled === '1';
            queueAction({ action: 'setAutoStack', gx, gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up auto-stack toggles (groups)
    panel.querySelectorAll('.info-auto-stack-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let enabled = btn.dataset.enabled === '1';
            let coords = btn.dataset.coords.split(';').map(c => { let [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; });
            for (let c of coords) queueAction({ action: 'setAutoStack', gx: c.gx, gy: c.gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up queue toggles (single)
    panel.querySelectorAll('.info-queue-toggle-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let enabled = btn.dataset.enabled === '1';
            queueAction({ action: 'setQueueEnabled', gx, gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up queue toggles (groups)
    panel.querySelectorAll('.info-queue-toggle-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let enabled = btn.dataset.enabled === '1';
            let coords = btn.dataset.coords.split(';').map(c => { let [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; });
            for (let c of coords) queueAction({ action: 'setQueueEnabled', gx: c.gx, gy: c.gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up auto-research toggles (single)
    panel.querySelectorAll('.info-auto-research-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let enabled = btn.dataset.enabled === '1';
            queueAction({ action: 'setAutoResearch', gx, gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up auto-research toggles (groups)
    panel.querySelectorAll('.info-auto-research-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let enabled = btn.dataset.enabled === '1';
            let coords = btn.dataset.coords.split(';').map(c => { let [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; });
            for (let c of coords) queueAction({ action: 'setAutoResearch', gx: c.gx, gy: c.gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up build-stage toggles (single)
    panel.querySelectorAll('.info-build-toggle-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let gx = parseInt(btn.dataset.gx), gy = parseInt(btn.dataset.gy);
            let enabled = btn.dataset.enabled === '1';
            queueAction({ action: 'setBuildEnabled', gx, gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up build-stage toggles (groups)
    panel.querySelectorAll('.info-build-toggle-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let enabled = btn.dataset.enabled === '1';
            let coords = btn.dataset.coords.split(';').map(c => { let [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; });
            for (let c of coords) queueAction({ action: 'setBuildEnabled', gx: c.gx, gy: c.gy, enabled });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up kill group buttons (units)
    panel.querySelectorAll('.info-kill-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let ids = btn.dataset.ids.split(',').map(Number);
            for (let id of ids) queueAction({ action: 'killUnit', unitId: id });
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up x2 /2 subgroup resize buttons (units)
    panel.querySelectorAll('.info-scale-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let ids = (btn.dataset.ids || '')
                .split(',')
                .map(v => parseInt(v))
                .filter(v => Number.isFinite(v));
            if (ids.length === 0) return;
            let mode = (btn.dataset.mode === 'x2') ? 'x2' : 'd2';
            let unitType = btn.dataset.unitType || null;
            let parsedLevel = parseInt(btn.dataset.unitLevel);
            let unitLevel = Number.isFinite(parsedLevel) ? parsedLevel : null;
            queueAction({ action: 'resizeUnitGroup', unitIds: ids, mode, unitType, unitLevel });
            setTimeout(updateInfoPanel, 50);
        });
    });

    if (!panelOverride) {
        let researchPopup = document.getElementById('research-popup');
        if (researchPopup && !researchPopup.classList.contains('hidden')) {
            renderResearchPopupContent();
        }
    }
    activeFormatBigNumberSuffixStart = prevFormatBigNumberSuffixStart;
}

function showGameOver() {
    let el = document.getElementById('game-over');
    el.style.display = 'flex';
    fullVisibility = true;
    document.getElementById('go-title').textContent = winner === localPlayerId ? 'VICTORY' : 'DEFEAT';
    document.getElementById('go-title').style.color = winner === localPlayerId ? '#4f4' : '#f44';
    let secs = Math.floor(gameTime / TICK_RATE);
    document.getElementById('go-stats').textContent = `Game lasted ${Math.floor(secs / 60)}m ${secs % 60}s`;
    let graphWrap = document.getElementById('go-graph-wrap');
    if (graphWrap) graphWrap.style.display = 'none';
    let btnPlayAgain = document.getElementById('go-btn-play-again');
    if (btnPlayAgain) btnPlayAgain.style.display = (isHost && isMultiplayer) ? 'inline-block' : 'none';
    renderGameGraph(graphMetric);
    playSound(winner === localPlayerId ? 'victory' : 'defeat');
}

// ============================================================
