
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
const PLAYER_STATUS_WORKER_UNIT_ORDER = ['collector', 'astar_collector', 'salvager_unit', 'builder_unit', 'healer_unit', 'researcher_unit'];
let infoPanelSectionCollapsed = {
    energyDelta: true,
    astarDelta: true,
    upKeep: true,
    upKeepUnits: true,
    upKeepBuildings: true,
    units: true,
    buildings: true
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
    astarCollector: ENERGY_DELTA_DEFAULT_WINDOW_SECONDS,
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
let activeResourcePenaltyPopupKey = '';

function _lerpChannel(a, b, t) {
    let mix = Math.max(0, Math.min(1, Number(t) || 0));
    return Math.round(a + ((b - a) * mix));
}

function _rgbToCss(rgb) {
    return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

function _lerpRgb(a, b, t) {
    return {
        r: _lerpChannel(a.r, b.r, t),
        g: _lerpChannel(a.g, b.g, t),
        b: _lerpChannel(a.b, b.b, t),
    };
}

function _getHudResourceValueColor(owner, resourceKey, value) {
    let player = players[Math.max(0, Math.floor(Number(owner) || 0))] || null;
    let maxSeen = Math.max(1, Number(player && player.resourceMaxValues && player.resourceMaxValues[resourceKey]) || 0);
    let currentValue = Number(value);
    if (!Number.isFinite(currentValue)) currentValue = 0;

    let red = { r: 255, g: 96, b: 96 };
    let yellow = { r: 255, g: 220, b: 96 };
    let green = { r: 112, g: 232, b: 112 };

    if (currentValue < 0) {
        let debtMix = Math.max(0, Math.min(1, 1 - (Math.abs(currentValue) / maxSeen)));
        return _rgbToCss(_lerpRgb(red, yellow, debtMix));
    }

    let gainMix = Math.max(0, Math.min(1, currentValue / maxSeen));
    return _rgbToCss(_lerpRgb(yellow, green, gainMix));
}

function _renderHudResource(el, cacheKey, owner, resourceKey, glyph, glyphColor, value) {
    if (!el) return;
    let numericValue = Number(value);
    if (!Number.isFinite(numericValue)) numericValue = 0;
    let flooredValue = Math.floor(numericValue);
    let valueColor = _getHudResourceValueColor(owner, resourceKey, flooredValue);
    let html = `<span class="hud-resource-glyph-btn" data-resource-key="${resourceKey}" title="Show ${resourceKey} stat effect details" style="color:${glyphColor};cursor:pointer;user-select:none">${glyph}</span> <span style="color:${valueColor}">${formatBigNumber(flooredValue)}</span>`;
    if (_hudCache[cacheKey] !== html) {
        _hudCache[cacheKey] = html;
        el.innerHTML = html;
    }
}

function _getResourcePopupCfg(resourceKey) {
    let stockpileKey = String(resourceKey || '').toLowerCase();
    for (let cfg of RESOURCE_TYPE_LIST) {
        if (String(cfg.stockpileKey || cfg.key || '').toLowerCase() === stockpileKey) return cfg;
    }
    return null;
}

function _getResourcePenaltyPercent(resourceKey, owner = localPlayerId) {
    let multiplier = Math.max(1, Number(_getPlayerResourcePenaltyMultiplier(owner, resourceKey)) || 1);
    return 100 / multiplier;
}

function _getResourcePenaltyStatsSummary(resourceKey) {
    let stockpileKey = String(resourceKey || '').toLowerCase();
    if (stockpileKey === 'astar') {
        return {
            primaryLabel: 'Unit speed',
            primaryText: 'Only unit speed uses A*. Positive A* has no penalty; negative A* slows units.',
            degradePercentLabel: 'Unit speed',
            worsenPercentLabel: '',
        };
    }
    return {
        primaryLabel: 'All other stats',
        primaryText: 'Energy is the fallback resource for all precomputed stats not explicitly mapped to another resource.',
        degradePercentLabel: 'Most affected stats',
        worsenPercentLabel: 'Cooldown / time / cost stats',
    };
}

function _getResourcePenaltyMarkerSpecs(maxSeen) {
    let safeMax = Math.max(1, Number(maxSeen) || 0);
    let out = [{ value: 0, percent: 100 }];
    let negativePercents = [50, 25, 12.5, 6.25, 3.125, 1.5625];
    for (let pct of negativePercents) {
        let steps = Math.log2(100 / pct);
        out.push({ value: -(steps * safeMax), percent: pct });
    }
    for (let steps = 1; steps <= 6; steps++) out.push({ value: steps * safeMax, percent: 100 });
    return out;
}

function _formatResourcePenaltyMarkerValue(value) {
    let numeric = Number(value) || 0;
    let prefix = numeric > 0 ? '+' : '';
    return `${prefix}${formatBigNumber(Math.floor(numeric), 1, 1000)}`;
}

function _buildResourcePenaltyBarHtml(currentValue, maxSeen) {
    let safeMax = Math.max(1, Number(maxSeen) || 0);
    let markers = _getResourcePenaltyMarkerSpecs(safeMax);
    let minValue = -6 * safeMax;
    let maxValue = 6 * safeMax;
    let span = Math.max(1, maxValue - minValue);
    let zeroPct = ((0 - minValue) / span) * 100;
    let currentPct = ((Math.max(minValue, Math.min(maxValue, Number(currentValue) || 0)) - minValue) / span) * 100;
    let markerHtml = markers.map((marker) => {
        let pct = ((marker.value - minValue) / span) * 100;
        return `<div style="position:absolute;left:${pct}%;top:0;bottom:0;transform:translateX(-50%);pointer-events:none">`
            + `<div style="position:absolute;top:8px;bottom:20px;width:1px;background:${marker.value === 0 ? 'rgba(255,245,180,0.78)' : 'rgba(255,255,255,0.18)'}"></div>`
            + `<div style="position:absolute;top:-6px;left:50%;transform:translateX(-50%);font-size:9px;color:${marker.value > 0 ? '#8fe28f' : marker.value < 0 ? '#ffbf9f' : '#f0df8d'};white-space:nowrap">${_formatResourcePenaltyMarkerValue(marker.value)}</div>`
            + `<div style="position:absolute;top:36px;left:50%;transform:translateX(-50%);font-size:9px;color:${marker.percent >= 100 ? '#8fe28f' : '#d8d1aa'};white-space:nowrap">${Math.max(1, Math.round(marker.percent))}%</div>`
            + `</div>`;
    }).join('');
    return `<div style="position:relative;margin:10px 6px 34px 6px;padding-top:14px">`
        + `<div style="position:relative;height:16px;border-radius:999px;overflow:hidden;border:1px solid #3a4b5a;background:linear-gradient(90deg,#8f1d1d 0%,#c4532f 18%,#d0b347 48%,#d0b347 52%,#7dbb55 76%,#3ea64d 100%)">`
        + `<div style="position:absolute;left:${zeroPct}%;top:-1px;bottom:-1px;width:2px;background:#f0df8d;opacity:0.9"></div>`
        + `<div style="position:absolute;left:${currentPct}%;top:-3px;bottom:-3px;width:3px;background:#f5f8ff;box-shadow:0 0 8px rgba(255,255,255,0.65)"></div>`
        + `</div>`
        + markerHtml
        + `</div>`;
}

const _RESOURCE_PENALTY_POPUP_EXEMPT_STATS = new Set([
    'upKeep',
    'astarCost',
    'popCap',
    'energy',
    'maxEnergy',
    'workerSearchDistance',
    'visionRange',
    'visionRangeArea',
    'attackRange',
    'attackRangeArea',
    'blastRadius'
]);

function _isResourcePenaltyPopupAffectedStat(resourceKey, kind, statKey) {
    let stockpileKey = String(resourceKey || '').toLowerCase();
    if (!stockpileKey || !kind || !statKey) return false;
    if (_RESOURCE_PENALTY_POPUP_EXEMPT_STATS.has(statKey)) return false;
    return _getResourceKeyForPrecomputedStat(kind, statKey) === stockpileKey;
}

function _getResourcePenaltyPopupStatEntries(resourceKey, owner = localPlayerId) {
    let stockpileKey = String(resourceKey || '').toLowerCase();
    let penaltyMultiplier = Math.max(1, Number(_getPlayerResourcePenaltyMultiplier(owner, stockpileKey)) || 1);
    let entries = [];
    let addEntries = (kind, prefix, statKeys) => {
        for (let statKey of statKeys) {
            if (!_isResourcePenaltyPopupAffectedStat(stockpileKey, kind, statKey)) continue;
            let worsensWithPenalty = !!RESEARCH_DECREASE_STATS[statKey];
            entries.push({
                label: `${prefix} ${RESEARCH_STAT_LABELS[statKey] || statKey}`,
                factor: worsensWithPenalty ? penaltyMultiplier : (1 / penaltyMultiplier)
            });
        }
    };
    addEntries('unit', 'Unit', PRECOMPUTED_UNIT_STAT_KEYS);
    addEntries('building', 'Building', PRECOMPUTED_BUILDING_STAT_KEYS);
    return entries;
}

function _formatResourcePenaltyPopupFactor(value) {
    let numeric = Number(value);
    if (!Number.isFinite(numeric)) numeric = 1;
    return `x${formatBigNumber(numeric, numeric >= 10 ? 1 : 2)}`;
}

function _buildResourcePenaltyAlgorithmHtml(currentValue, maxSeen, penaltyMultiplier, resourceKey) {
    let stockpileKey = String(resourceKey || '').toLowerCase();
    let base = Number(RESOURCE_NEGATIVE_PENALTY_BASE) || 1;
    let safeCurrent = Number(currentValue) || 0;
    let safeMax = Math.max(1, Number(maxSeen) || 0);
    let absCurrent = Math.abs(Math.min(0, safeCurrent));
    let fasterStatsLine = stockpileKey === 'astar'
        ? `Affected stats -> base / p`
        : `Damage / rate stats -> base / p`;
    let slowerStatsLine = stockpileKey === 'astar'
        ? ''
        : `Cooldown / time / cost stats -> base * p`;
    let html = `<div style="padding:8px 10px;border:1px solid #2f4457;border-radius:6px;background:#0f151b;font:12px/1.5 Consolas, 'Courier New', monospace;color:#d9e8f6">`;
    html += `<div>current = ${formatBigNumber(safeCurrent, 1)}</div>`;
    html += `<div>maxSeen = ${formatBigNumber(safeMax, 1)}</div>`;
    html += `<div>&gt;= 0 -&gt; p = 1.00</div>`;
    html += `<div>&lt; 0 -&gt; p = ${formatBigNumber(base, 2)}^(abs(resource) / maxSeen)</div>`;
    html += `<div>current p = ${formatBigNumber(base, 2)}^(${formatBigNumber(absCurrent, 1)} / ${formatBigNumber(safeMax, 1)}) = ${_formatResourcePenaltyPopupFactor(penaltyMultiplier)}</div>`;
    html += `<div>${_escapeHtml(fasterStatsLine)}</div>`;
    if (slowerStatsLine) html += `<div>${_escapeHtml(slowerStatsLine)}</div>`;
    html += `</div>`;
    return html;
}

function _buildResourcePenaltyAffectedStatsHtml(resourceKey, owner = localPlayerId) {
    let rows = _getResourcePenaltyPopupStatEntries(resourceKey, owner);
    if (!rows.length) {
        return `<div style="padding:8px 10px;border:1px solid #2f4457;border-radius:6px;background:#0f151b;color:#9fb2c4">No affected precomputed stats.</div>`;
    }
    let body = rows.map((entry) => {
        return `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:6px 0;border-top:1px solid rgba(255,255,255,0.06)">`
            + `<div style="color:#dce9f7">${_escapeHtml(entry.label)}</div>`
            + `<div style="color:#f0df8d">${_escapeHtml(_formatResourcePenaltyPopupFactor(entry.factor))}</div>`
            + `</div>`;
    }).join('');
    return `<div style="padding:8px 10px;border:1px solid #2f4457;border-radius:6px;background:#0f151b">`
        + `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;font-size:11px;color:#8fb1c7;padding-bottom:6px">`
        + `<div>Affected stat</div>`
        + `<div>Multiplier</div>`
        + `</div>`
        + body
        + `</div>`;
}

function ensureResourcePenaltyPopupElements() {
    let popup = document.getElementById('resource-penalty-popup');
    if (popup) return popup;
    popup = document.createElement('div');
    popup.id = 'resource-penalty-popup';
    popup.className = 'hidden';
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    popup.setAttribute('aria-labelledby', 'resource-penalty-title');
    popup.innerHTML = `<div id="resource-penalty-popup-card" style="width:min(520px, calc(100vw - 32px));max-width:520px;background:#10161d;border:1px solid #3c5368;border-radius:8px;box-shadow:0 18px 48px rgba(0,0,0,0.45);padding:14px 16px;color:#d8ecff;display:flex;flex-direction:column;gap:10px;max-height:min(82vh, 760px);overflow:auto">`
        + `<div class="help-title-row" style="display:flex;align-items:center;justify-content:space-between;gap:10px">`
        + `<h3 id="resource-penalty-title" style="color:#8dc6ff; font-size:18px; margin:0">Resource Details</h3>`
        + `<button id="btn-resource-penalty-close" style="background:#252525; border:1px solid #555; color:#ddd; cursor:pointer; font-size:12px; padding:4px 8px; border-radius:4px;">Close</button>`
        + `</div>`
        + `<div id="resource-penalty-content"></div>`
        + `</div>`;
    popup.style.position = 'fixed';
    popup.style.inset = '0';
    popup.style.background = 'rgba(0,0,0,0.52)';
    popup.style.display = 'none';
    popup.style.alignItems = 'center';
    popup.style.justifyContent = 'center';
    popup.style.zIndex = '2200';
    document.body.appendChild(popup);

    let closeBtn = popup.querySelector('#btn-resource-penalty-close');
    if (closeBtn) closeBtn.addEventListener('click', () => setResourcePenaltyPopupOpen(false));
    popup.addEventListener('click', (ev) => {
        if (ev.target === popup) setResourcePenaltyPopupOpen(false);
    });
    return popup;
}

function buildResourcePenaltyPopupHtml(resourceKey, owner = localPlayerId) {
    let cfg = _getResourcePopupCfg(resourceKey);
    if (!cfg) return '<div style="color:#f99">Unknown resource.</div>';
    let player = players[Math.max(0, Math.floor(Number(owner) || 0))] || null;
    let stockpileKey = String(cfg.stockpileKey || cfg.key || '');
    let currentValue = Number(player && player[stockpileKey]);
    if (!Number.isFinite(currentValue)) currentValue = 0;
    let maxSeen = Math.max(1, Number(player && player.resourceMaxValues && player.resourceMaxValues[stockpileKey]) || 0);
    let penaltyMultiplier = Math.max(1, Number(_getPlayerResourcePenaltyMultiplier(owner, stockpileKey)) || 1);

    let html = `<div style="display:flex;flex-direction:column;gap:10px">`;
    html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">`
        + `<div style="display:flex;align-items:center;gap:10px"><span style="font-size:28px;color:${cfg.color}">${cfg.icon}</span><div style="font-size:18px;color:#dff3ff;font-weight:600">${_escapeHtml(cfg.label)} Effects</div></div>`
        + `<div style="font-size:12px;color:#a7bed0">p = ${_escapeHtml(_formatResourcePenaltyPopupFactor(penaltyMultiplier))}</div>`
        + `</div>`;
    html += _buildResourcePenaltyBarHtml(currentValue, maxSeen);
    html += _buildResourcePenaltyAlgorithmHtml(currentValue, maxSeen, penaltyMultiplier, stockpileKey);
    html += _buildResourcePenaltyAffectedStatsHtml(stockpileKey, owner);
    html += `</div>`;
    return html;
}

function setResourcePenaltyPopupOpen(open, resourceKey = activeResourcePenaltyPopupKey, owner = localPlayerId) {
    let popup = ensureResourcePenaltyPopupElements();
    if (!popup) return false;
    let wasOpen = popup.style.display !== 'none';
    if (open) {
        activeResourcePenaltyPopupKey = String(resourceKey || activeResourcePenaltyPopupKey || 'energy');
        let titleEl = document.getElementById('resource-penalty-title');
        let cfg = _getResourcePopupCfg(activeResourcePenaltyPopupKey);
        if (titleEl) titleEl.textContent = `${cfg ? cfg.label : 'Resource'} Effects`;
        let contentEl = document.getElementById('resource-penalty-content');
        if (contentEl) contentEl.innerHTML = buildResourcePenaltyPopupHtml(activeResourcePenaltyPopupKey, owner);
    }
    popup.style.display = open ? 'flex' : 'none';
    if (!open) activeResourcePenaltyPopupKey = '';
    return wasOpen !== open;
}

function refreshResourcePenaltyPopupContent(owner = localPlayerId) {
    let popup = document.getElementById('resource-penalty-popup');
    if (!popup || popup.style.display === 'none' || !activeResourcePenaltyPopupKey) return;
    let titleEl = document.getElementById('resource-penalty-title');
    let cfg = _getResourcePopupCfg(activeResourcePenaltyPopupKey);
    if (titleEl) titleEl.textContent = `${cfg ? cfg.label : 'Resource'} Effects`;
    let contentEl = document.getElementById('resource-penalty-content');
    if (contentEl) contentEl.innerHTML = buildResourcePenaltyPopupHtml(activeResourcePenaltyPopupKey, owner);
}

function _bindHudResourcePopupTrigger(el, resourceKey) {
    if (!el || el.dataset.resourcePopupBound === '1') return;
    el.dataset.resourcePopupBound = '1';
    el.addEventListener('click', (ev) => {
        let glyph = ev.target instanceof Element ? ev.target.closest('.hud-resource-glyph-btn') : null;
        if (!glyph) return;
        let key = String(glyph.getAttribute('data-resource-key') || resourceKey || '');
        if (!key) return;
        setResourcePenaltyPopupOpen(true, key, localPlayerId);
    });
}

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

function _buildCollapsibleInfoSectionTitle(sectionKey, title, rightHtml = '', selectCfg = null) {
    let collapsed = _isInfoSectionCollapsed(sectionKey);
    let arrow = collapsed ? '▸' : '▾';
    let trailingHtml = rightHtml
        ? `<span style="display:inline-flex;align-items:center;gap:4px;flex:0 0 auto">${rightHtml}</span>`
        : '';
    let titleHtml = '';
    if (selectCfg && selectCfg.domain) {
        let safeDomain = _escapeHtml(String(selectCfg.domain || ''));
        let safeFilter = _escapeHtml(String(selectCfg.filterKey || 'total'));
        let safeMode = _escapeHtml(String(selectCfg.mode || 'all'));
        let safeTitle = _escapeHtml(String(selectCfg.title || title || 'Select'));
        titleHtml = `<button type="button" class="info-title info-player-status-select-btn" data-domain="${safeDomain}" data-filter="${safeFilter}" data-mode="${safeMode}" title="${safeTitle}" style="cursor:pointer;user-select:none;flex:0 0 56px;min-width:56px;max-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;background:#1a1f26;border:1px solid #354453;border-radius:4px;padding:1px 6px;color:#dce9f7;font:inherit;line-height:1.2">${_escapeHtml(String(title || ''))}</button>`;
    } else {
        titleHtml = `<div class="info-title info-section-toggle" data-section-key="${sectionKey}" style="cursor:pointer;user-select:none;flex:0 0 56px;min-width:56px;max-width:56px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escapeHtml(String(title || ''))}</div>`;
    }
    return `<div style="display:flex;align-items:center;justify-content:flex-start;gap:4px;margin-bottom:2px">`
        + `<button type="button" class="info-section-toggle" data-section-key="${sectionKey}" title="${collapsed ? 'Expand' : 'Collapse'} ${_escapeHtml(String(title || 'section'))}" style="cursor:pointer;user-select:none;flex:0 0 auto;width:18px;min-width:18px;height:18px;line-height:1;background:transparent;border:0;padding:0;color:#ddd;font:inherit;text-align:center">${arrow}</button>`
        + titleHtml
        + trailingHtml
        + `<div class="info-section-toggle" data-section-key="${sectionKey}" style="cursor:pointer;user-select:none;flex:1 1 auto;min-width:0;height:18px"></div>`
        + `</div>`;
}

function _buildInfoPanelRosterModeButtonHtml(domain, filterKey, mode, label, title, widthPx = 35) {
    let safeDomain = _escapeHtml(String(domain || 'units'));
    let safeFilter = _escapeHtml(String(filterKey || 'total'));
    let safeMode = _escapeHtml(String(mode || 'all'));
    let safeLabel = _escapeHtml(String(label || ''));
    let safeTitle = _escapeHtml(String(title || safeLabel));
    let width = Math.max(20, Math.floor(Number(widthPx) || 35));
    return `<button type="button" class="info-player-status-select-btn" data-domain="${safeDomain}" data-filter="${safeFilter}" data-mode="${safeMode}" style="cursor:pointer;color:#ddd;width:${width}px;min-width:${width}px;max-width:${width}px;height:20px;text-align:center;background:#161616;border:1px solid #333;border-radius:3px;padding:0;font:inherit;line-height:1" title="${safeTitle}">${safeLabel}</button>`;
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
        if (ev.source === 'upKeep') continue;
        if (sourceKey && ev.source !== sourceKey) continue;
        let d = Number(ev.delta) || 0;
        sum += d;
    }

    // Always present values as energy-per-second regardless of window length.
    return sum / sec;
}

function recordAstarDelta(owner, delta, unit = null, sourceTag = null) {
    let d = Number(delta);
    if (!Number.isFinite(d) || Math.abs(d) <= 1e-9) return;

    let pid = _normalizeOwnerId(owner);
    if (pid < 0) return;

    let bucket = _ensureAstarLogPlayer(pid);
    if (!bucket) return;

    let unitType = String((unit && unit.unitType) || 'other');
    let unitMetric = _astarMetricKeyForUnitType(unitType);
    let unitId = (unit && Number.isFinite(Number(unit.id))) ? Math.floor(Number(unit.id)) : null;
    bucket.push({
        tick: gameTime,
        owner: pid,
        unitType,
        unitMetric,
        unitId,
        source: String(sourceTag || ''),
        used: d < 0 ? Math.abs(d) : 0,
        delta: d,
    });

    let pruneBefore = gameTime - Math.max(1, Math.floor(TICK_RATE * ASTAR_USAGE_LOG_MAX_SECONDS));
    while (bucket.length > 0 && Number(bucket[0].tick) < pruneBefore) bucket.shift();
}

function buildInfoPanelEnergyDeltaHtml(owner) {
    if (!Number.isFinite(owner) || owner < 0 || owner >= players.length) return '';

    let upkeepBreakdown = (typeof getPlayerUpKeepBreakdown === 'function')
        ? getPlayerUpKeepBreakdown(owner)
        : { total: 0, unitTypes: {}, buildingTypes: {} };
    let upkeepUnitTypes = upkeepBreakdown && upkeepBreakdown.unitTypes ? upkeepBreakdown.unitTypes : {};
    let upkeepBuildingTypes = upkeepBreakdown && upkeepBreakdown.buildingTypes ? upkeepBreakdown.buildingTypes : {};
    let getUpkeepForMetric = (metric) => {
        if (metric === 'total') return Math.max(0, Number(upkeepBreakdown && upkeepBreakdown.total) || 0);
        if (metric === 'collect') return Math.max(0, Number(upkeepUnitTypes.collector) || 0);
        if (metric === 'salvage') return Math.max(0, Number(upkeepUnitTypes.salvager_unit) || 0);
        if (metric === 'research') return Math.max(0, Number(upkeepUnitTypes.researcher_unit) || 0);
        if (metric === 'builder') return Math.max(0, Number(upkeepUnitTypes.builder_unit) || 0);
        if (metric === 'healer') return Math.max(0, Number(upkeepUnitTypes.healer_unit) || 0);
        return 0;
    };

    let fmt = (v) => {
        if (!Number.isFinite(v) || Math.abs(v) < 0.05) return '0.0';
        return `${v > 0 ? '+' : ''}${formatBigNumber(v, 1)}`;
    };
    let color = (v) => {
        if (v > 0.05) return '#6f6';
        if (v < -0.05) return '#f88';
        return '#dd6';
    };
    let row = (metric, sourceKey, thumbSpec = null, label = '', filterKey = 'total', domain = 'units') => {
        let sec = getEnergyDeltaWindowSeconds(metric);
        let value = getPlayerEnergyDeltaRate(owner, sourceKey, sec) - getUpkeepForMetric(metric);
        let thingHtml = label
            ? _buildInfoPanelThingSelectableLabelHtml(domain, filterKey, label, thumbSpec, 103, `Select all ${label || filterKey}`)
            : _buildInfoPanelThingSelectableVisualHtml(domain, filterKey, thumbSpec, 40, `Select all ${filterKey}`);
        return `<div class="info-row" style="margin:0;gap:6px;align-items:center">`
            + `<button class="info-energy-delta-window-btn" data-metric="${metric}" title="Window: ${sec}s (click to cycle 1s/10s/30s/60s)" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center">${sec}s</button>`
            + thingHtml
            + `<span class="info-value" style="color:${color(value)};flex:0 0 84px;min-width:84px;padding-left:4px;text-align:right;font-variant-numeric:tabular-nums">${fmt(value)} ⚡/ s</span>`
            + `</div>`;
    };

    let totalSec = getEnergyDeltaWindowSeconds('total');
    let totalValue = getPlayerEnergyDeltaRate(owner, '', totalSec) - getUpkeepForMetric('total');
    let energyDeltaHeaderControls = _buildInfoPanelRosterModeButtonHtml('all-owned', 'total', 'all', 'All', 'Select all owned units and buildings', 28)
        + `<button class="info-energy-delta-window-btn" data-metric="total" title="Window: ${totalSec}s (click to cycle 1s/10s/30s/60s)" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center">${totalSec}s</button>`
        + `<span class="info-value" style="color:${color(totalValue)};flex:0 0 84px;min-width:84px;padding-left:4px;text-align:right;font-variant-numeric:tabular-nums">${fmt(totalValue)} ⚡/ s</span>`;
    let html = _buildCollapsibleInfoSectionTitle('energyDelta', '⚡/ s', energyDeltaHeaderControls);
    if (!_isInfoSectionCollapsed('energyDelta')) {
        html += row('collect', 'collect', { thumbKey: 'collector', isUnit: true }, '', 'collector', 'units');
        html += row('salvage', 'salvage', { thumbKey: 'salvager_unit', isUnit: true }, '', 'salvager_unit', 'units');
        html += row('research', 'research', { thumbKey: 'researcher_unit', isUnit: true }, '', 'researcher_unit', 'units');
        html += row('builder', 'builder', { thumbKey: 'builder_unit', isUnit: true }, '', 'builder_unit', 'units');
        html += row('healer', 'healer', { thumbKey: 'healer_unit', isUnit: true }, '', 'healer_unit', 'units');

        // Keep worker rows explicit, but also show any remaining unit upkeep types
        // so the rows reconcile with the total panel value.
        let explicitWorkerTypes = new Set(['collector', 'salvager_unit', 'researcher_unit', 'builder_unit', 'healer_unit']);
        let otherUnitKeys = Object.keys(upkeepUnitTypes)
            .filter(k => (Number(upkeepUnitTypes[k]) || 0) > 0 && !explicitWorkerTypes.has(k))
            .sort((a, b) => _prettyUnitTypeLabel(a).localeCompare(_prettyUnitTypeLabel(b)));
        if (otherUnitKeys.length > 0) {
            html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
            for (let unitType of otherUnitKeys) {
                let unitUpkeep = Math.max(0, Number(upkeepUnitTypes[unitType]) || 0);
                let unitValue = -unitUpkeep;
                let sec = getEnergyDeltaWindowSeconds(`unit_${unitType}`);
                let thingHtml = _buildInfoPanelThingSelectableVisualHtml('units', unitType, { thumbKey: unitType, isUnit: true }, 40, `Select all ${unitType}`);
                html += `<div class="info-row" style="margin:0;gap:6px;align-items:center">`
                    + `<button class="info-energy-delta-window-btn" data-metric="unit_${unitType}" title="Window: ${sec}s (click to cycle 1s/10s/30s/60s)" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center">${sec}s</button>`
                    + thingHtml
                    + `<span class="info-value" style="color:${color(unitValue)};flex:0 0 84px;min-width:84px;padding-left:4px;text-align:right;font-variant-numeric:tabular-nums">${fmt(unitValue)} ⚡/ s</span>`
                    + `</div>`;
            }
        }
        
        let buildingKeys = Object.keys(upkeepBuildingTypes).filter(k => (Number(upkeepBuildingTypes[k]) || 0) > 0).sort((a, b) => _prettyBuildingTypeLabel(a).localeCompare(_prettyBuildingTypeLabel(b)));
        if (buildingKeys.length > 0) {
            html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
            for (let buildingType of buildingKeys) {
                let buildingUpkeep = Math.max(0, Number(upkeepBuildingTypes[buildingType]) || 0);
                let buildingValue = -buildingUpkeep;
                let sec = getEnergyDeltaWindowSeconds('total');
                let thingHtml = _buildInfoPanelThingSelectableVisualHtml('buildings', buildingType, { thumbKey: buildingType, isUnit: false }, 40, `Select all ${buildingType}`);
                html += `<div class="info-row" style="margin:0;gap:6px;align-items:center">`
                    + `<button class="info-energy-delta-window-btn" data-metric="building_${buildingType}" title="Window: ${sec}s (click to cycle 1s/10s/30s/60s)" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center">${sec}s</button>`
                    + thingHtml
                    + `<span class="info-value" style="color:${color(buildingValue)};flex:0 0 84px;min-width:84px;padding-left:4px;text-align:right;font-variant-numeric:tabular-nums">${fmt(buildingValue)} ⚡/ s</span>`
                    + `</div>`;
            }
        }
    }
    html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    return html;
}

function _getPlayerAstarDeltaRate(owner, windowSeconds, matcherFn) {
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
        let delta = Number.isFinite(Number(ev.delta)) ? Number(ev.delta) : -(Math.max(0, Number(ev.used) || 0));
        sum += delta;
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

function _prettyBuildingTypeLabel(buildingType) {
    let key = String(buildingType || 'unknown');
    if (key.startsWith('tower:')) {
        key = key.slice('tower:'.length);
    }
    if (key.startsWith('barrack:')) {
        return `${_prettyUnitTypeLabel(key.slice('barrack:'.length))} Barrack`;
    }
    if (key.startsWith('barrack_')) {
        return `${_prettyUnitTypeLabel(key.slice('barrack_'.length))} Barrack`;
    }
    let def = BASE_CARD_TYPES[key];
    if (def && def.name) return String(def.name);
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function _buildInfoPanelThingLabelHtml(label, thumbSpec = null, labelWidth = 103) {
    let safeLabel = _escapeHtml(String(label || ''));
    if (!thumbSpec || !thumbSpec.thumbKey) {
        return `<span style="display:inline-flex;align-items:center;gap:4px;flex:0 0 ${labelWidth}px;min-width:${labelWidth}px;max-width:${labelWidth}px">`
            + `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 40px;min-width:40px;max-width:40px;color:#bbb">${safeLabel}</span>`
            + `</span>`;
    }
    let isUnit = !!thumbSpec.isUnit;
    let borderRadius = isUnit ? '50%' : '4px';
    let thumbKey = String(thumbSpec.thumbKey || '');
    return `<span style="display:inline-flex;align-items:center;gap:4px;flex:0 0 ${labelWidth}px;min-width:${labelWidth}px;max-width:${labelWidth}px">`
        + `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 40px;min-width:40px;max-width:40px">`
        + `<span style="width:22px;height:22px;padding:0;border:1px solid #333;border-radius:${borderRadius};background:#111;display:flex;align-items:center;justify-content:center;flex:0 0 auto"><img src="${getItemThumbnail(thumbKey, 18)}" width="18" height="18" style="display:block;${isUnit ? 'border-radius:50%;' : 'border-radius:3px;'}"></span>`
        + `</span>`
        + `<span class="info-label" style="color:#bbb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeLabel}</span>`
        + `</span>`;
}

function _buildInfoPanelThingVisualOnlyHtml(thumbSpec = null, width = 40) {
    if (!thumbSpec || !thumbSpec.thumbKey) {
        return `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 ${width}px;min-width:${width}px;max-width:${width}px"></span>`;
    }
    let isUnit = !!thumbSpec.isUnit;
    let borderRadius = isUnit ? '50%' : '4px';
    let thumbKey = String(thumbSpec.thumbKey || '');
    return `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 ${width}px;min-width:${width}px;max-width:${width}px">`
        + `<span style="width:22px;height:22px;padding:0;border:1px solid #333;border-radius:${borderRadius};background:#111;display:flex;align-items:center;justify-content:center;flex:0 0 auto"><img src="${getItemThumbnail(thumbKey, 18)}" width="18" height="18" style="display:block;${isUnit ? 'border-radius:50%;' : 'border-radius:3px;'}"></span>`
        + `</span>`;
}

function _buildInfoPanelThingSelectButtonHtml(domain, filterKey, label, thumbSpec = null, title = '') {
    let safeDomain = _escapeHtml(String(domain || 'units'));
    let safeFilter = _escapeHtml(String(filterKey || 'total'));
    let safeLabel = _escapeHtml(String(label || ''));
    let safeTitle = _escapeHtml(String(title || `Select all ${safeLabel || safeFilter}`));
    if (thumbSpec && thumbSpec.thumbKey) {
        let isUnit = !!thumbSpec.isUnit;
        let borderRadius = isUnit ? '50%' : '4px';
        let thumbKey = String(thumbSpec.thumbKey || '');
        return `<button type="button" class="info-player-status-select-btn" data-domain="${safeDomain}" data-filter="${safeFilter}" data-mode="all" title="${safeTitle}" style="width:22px;height:22px;padding:0;border:1px solid #333;border-radius:${borderRadius};background:#111;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto"><img src="${getItemThumbnail(thumbKey, 18)}" width="18" height="18" style="display:block;${isUnit ? 'border-radius:50%;' : 'border-radius:3px;'}"></button>`;
    }
    return `<button type="button" class="info-player-status-select-btn" data-domain="${safeDomain}" data-filter="${safeFilter}" data-mode="all" title="${safeTitle}" style="cursor:pointer;color:#bbb;width:40px;min-width:40px;max-width:40px;height:22px;text-align:center;background:#161616;border:1px solid #333;border-radius:3px;padding:0;font:inherit;line-height:1">${safeLabel}</button>`;
}

function _buildInfoPanelThingSelectableLabelHtml(domain, filterKey, label, thumbSpec = null, labelWidth = 103, title = '') {
    let safeLabel = _escapeHtml(String(label || ''));
    let buttonHtml = _buildInfoPanelThingSelectButtonHtml(domain, filterKey, label, thumbSpec, title);
    if (!thumbSpec || !thumbSpec.thumbKey) {
        return `<span style="display:inline-flex;align-items:center;gap:4px;flex:0 0 ${labelWidth}px;min-width:${labelWidth}px;max-width:${labelWidth}px">`
            + `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 40px;min-width:40px;max-width:40px">${buttonHtml}</span>`
            + `</span>`;
    }
    return `<span style="display:inline-flex;align-items:center;gap:4px;flex:0 0 ${labelWidth}px;min-width:${labelWidth}px;max-width:${labelWidth}px">`
        + `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 40px;min-width:40px;max-width:40px">${buttonHtml}</span>`
        + `<span class="info-label" style="color:#bbb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${safeLabel}</span>`
        + `</span>`;
}

function _buildInfoPanelThingSelectableVisualHtml(domain, filterKey, thumbSpec = null, width = 40, title = '') {
    let buttonHtml = _buildInfoPanelThingSelectButtonHtml(domain, filterKey, '', thumbSpec, title);
    return `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 ${width}px;min-width:${width}px;max-width:${width}px">${buttonHtml}</span>`;
}

function buildInfoPanelAstarBudgetHtml(owner) {
    if (!Number.isFinite(owner) || owner < 0 || owner >= players.length) return '';

    let fmtDelta = (v) => {
        if (!Number.isFinite(v) || Math.abs(v) < 0.05) return '0.0';
        return `${v > 0 ? '+' : ''}${formatBigNumber(v, 1)}`;
    };
    let colorDelta = (v) => {
        if (v > 0.05) return '#8f8';
        if (v < -0.05) return '#f88';
        return '#9aa';
    };
    let secBtn = (metric, sec) => `<button class="info-astar-window-btn" data-metric="${metric}" title="Window: ${sec}s (click to cycle 1s/10s/30s/60s)" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center">${sec}s</button>`;

    let deltaRow = (metric, matcherFn, thumbSpec = null, label = '', filterKey = 'total', domain = 'units') => {
        let sec = getAstarWindowSeconds(metric);
        let value = _getPlayerAstarDeltaRate(owner, sec, matcherFn);
        let thingHtml = label
            ? _buildInfoPanelThingSelectableLabelHtml(domain, filterKey, label, thumbSpec, 103, `Select all ${label || filterKey}`)
            : _buildInfoPanelThingSelectableVisualHtml(domain, filterKey, thumbSpec, 40, `Select all ${filterKey}`);
        return `<div class="info-row" style="margin:0;gap:6px;align-items:center">`
            + secBtn(metric, sec)
            + thingHtml
            + `<span class="info-value" style="color:${colorDelta(value)};flex:0 0 84px;min-width:84px;padding-left:4px;text-align:right;font-variant-numeric:tabular-nums">${fmtDelta(value)} ★ / s</span>`
            + `</div>`;
    };

    let totalSec = getAstarWindowSeconds('total');
    let totalValue = _getPlayerAstarDeltaRate(owner, totalSec, null);
    let astarHeaderControls = _buildInfoPanelRosterModeButtonHtml('all-owned', 'total', 'all', 'All', 'Select all owned units and buildings', 28)
        + `<button class="info-astar-window-btn" data-metric="total" title="Window: ${totalSec}s (click to cycle 1s/10s/30s/60s)" style="cursor:pointer;background:#1b1b1b;color:#9dd;border:1px solid #3b4a52;border-radius:3px;font-size:10px;line-height:1;padding:1px 5px;min-width:34px;text-align:center">${totalSec}s</button>`
        + `<span class="info-value" style="color:${colorDelta(totalValue)};flex:0 0 84px;min-width:84px;padding-left:4px;text-align:right;font-variant-numeric:tabular-nums">${fmtDelta(totalValue)} ★ / s</span>`;
    let html = _buildCollapsibleInfoSectionTitle('astarDelta', '★ / s', astarHeaderControls);
    if (!_isInfoSectionCollapsed('astarDelta')) {
        html += deltaRow('astarCollector', ev => ev.unitType === 'astar_collector', { thumbKey: 'astar_collector', isUnit: true }, '', 'astar_collector', 'units');
        html += deltaRow('king', ev => ev.unitMetric === 'king', { thumbKey: 'king', isUnit: true }, '', 'king', 'units');
        html += deltaRow('collector', ev => ev.unitMetric === 'collector', { thumbKey: 'collector', isUnit: true }, '', 'collector', 'units');
        html += deltaRow('salvager', ev => ev.unitMetric === 'salvager', { thumbKey: 'salvager_unit', isUnit: true }, '', 'salvager_unit', 'units');
        html += deltaRow('builder', ev => ev.unitMetric === 'builder', { thumbKey: 'builder_unit', isUnit: true }, '', 'builder_unit', 'units');
        html += deltaRow('healer', ev => ev.unitMetric === 'healer', { thumbKey: 'healer_unit', isUnit: true }, '', 'healer_unit', 'units');
        html += deltaRow('researcher', ev => ev.unitMetric === 'researcher', { thumbKey: 'researcher_unit', isUnit: true }, '', 'researcher_unit', 'units');

        let special = new Set(['king', 'collector', 'astar_collector', 'salvager_unit', 'builder_unit', 'healer_unit', 'researcher_unit']);
        let otherTypes = new Set();
        for (let u of units) {
            if (!u || u.dead || u.owner !== owner) continue;
            if (special.has(u.unitType)) continue;
            otherTypes.add(String(u.unitType || 'other'));
        }
        let sortedOtherTypes = Array.from(otherTypes).sort();
        for (let unitType of sortedOtherTypes) {
            let metric = `u_${unitType}`;
            html += deltaRow(metric, ev => ev.unitType === unitType, { thumbKey: unitType, isUnit: true }, '', unitType, 'units');
        }
        
        let buildingTypes = (typeof getPlayerUpKeepBreakdown === 'function')
            ? (getPlayerUpKeepBreakdown(owner).buildingTypes || {})
            : {};
        let buildingKeys = Object.keys(buildingTypes).filter(k => buildingTypes[k]).sort((a, b) => _prettyBuildingTypeLabel(a).localeCompare(_prettyBuildingTypeLabel(b)));
        if (buildingKeys.length > 0) {
            html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
            for (let buildingType of buildingKeys) {
                html += deltaRow(`b_${buildingType}`, () => false, { thumbKey: buildingType, isUnit: false }, '', buildingType, 'buildings');
            }
        }
    }
    html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    return html;
}

function buildInfoPanelUpKeepHtml(owner) {
    if (!Number.isFinite(owner) || owner < 0 || owner >= players.length) return '';

    let breakdown = (typeof getPlayerUpKeepBreakdown === 'function')
        ? getPlayerUpKeepBreakdown(owner)
        : { total: 0, units: 0, buildings: 0, turrets: 0, unitTypes: {}, buildingTypes: {} };
    let fmt = (v) => formatBigNumber(Math.max(0, Number(v) || 0), 2);
    let totalRow = (value) => `<div class="info-row" style="margin:0;gap:8px;align-items:center">`
        + _buildInfoPanelThingSelectableLabelHtml('upkeep-total', 'total', 'Total', null, 40, 'Select all upkeep things')
        + `<span class="info-value" style="color:#f88">-${fmt(value)}⚡/ s</span>`
        + `</div>`;
    let typedRow = (value, thumbSpec, domain, filterKey) => `<div class="info-row" style="margin:0;gap:8px;align-items:center">`
        + _buildInfoPanelThingSelectableVisualHtml(domain, filterKey, thumbSpec, 40, `Select all ${filterKey}`)
        + `<span class="info-value" style="color:#f88">-${fmt(value)}⚡/ s</span>`
        + `</div>`;

    let html = _buildCollapsibleInfoSectionTitle('upKeep', 'UpKeep');
    if (!_isInfoSectionCollapsed('upKeep')) {
        html += totalRow(breakdown.total);

        let unitTypes = breakdown.unitTypes || {};
        let unitKeys = Object.keys(unitTypes).filter(k => (Number(unitTypes[k]) || 0) > 0).sort(_compareInfoPanelUnitTypes);
        for (let unitType of unitKeys) {
            html += typedRow(unitTypes[unitType], { thumbKey: unitType, isUnit: true }, 'upkeep-units', unitType);
        }
        if (unitKeys.length > 0) {
            html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
        }

        let buildingTypes = breakdown.buildingTypes || {};
        let buildingKeys = Object.keys(buildingTypes).filter(k => (Number(buildingTypes[k]) || 0) > 0).sort((a, b) => _prettyBuildingTypeLabel(a).localeCompare(_prettyBuildingTypeLabel(b)));
        for (let buildingType of buildingKeys) {
            html += typedRow(buildingTypes[buildingType], { thumbKey: buildingType, isUnit: false }, 'upkeep-buildings', buildingType);
        }

        if (unitKeys.length <= 0 && buildingKeys.length <= 0) {
            html += `<div class="info-row" style="margin:0;gap:8px;align-items:center">` + _buildInfoPanelThingLabelHtml('None', null) + `<span class="info-value" style="color:#999">0.00⚡/ s</span></div>`;
        }
    }
    html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    return html;
}

function _isInfoPanelUnitIdleLike(u) {
    if (!u || u.dead) return false;
    let pathDone = (!u.path || u.pathIndex >= u.path.length);
    if (u.workerType) return (u.workerState === 'IDLE') || (u.commandState === CMD_HOLDING) || (!u.workerTarget && pathDone);
    if (u.commandState === CMD_IDLE || u.commandState === CMD_HOLDING) return true;
    return !u.target && pathDone;
}

function _getOwnedInfoPanelUnits(owner) {
    let out = [];
    for (let u of units) {
        if (!u || u.dead || u.owner !== owner) continue;
        out.push(u);
    }
    return out;
}

function _compareInfoPanelUnitTypes(a, b) {
    let ai = PLAYER_STATUS_WORKER_UNIT_ORDER.indexOf(a);
    let bi = PLAYER_STATUS_WORKER_UNIT_ORDER.indexOf(b);
    if (ai >= 0 || bi >= 0) return (ai < 0 ? 1e9 : ai) - (bi < 0 ? 1e9 : bi);
    return _prettyUnitTypeLabel(a).localeCompare(_prettyUnitTypeLabel(b));
}

function _getOwnedInfoPanelBuildings(owner) {
    let out = [];
    let seen = new Set();

    let tryAdd = (item) => {
        if (!item || item.owner !== owner) return;
        if (seen.has(item)) return;
        if (_isGoldMineLikeEntity(item) || _isAstarMineLikeEntity(item)) return;
        if (!(Number(item.energy) > 0) && !item.underConstruction) return;
        seen.add(item);
        out.push(item);
    };

    for (let t of towers) tryAdd(t);
    for (let b of barracks) tryAdd(b);
    for (let s of collectorSpawners) tryAdd(s);

    for (let y = 0; y < GRID_H; y++) {
        for (let x = 0; x < GRID_W; x++) {
            let cell = grid[y] && grid[y][x];
            if (!cell || cell.owner !== owner || !cell.item) continue;
            tryAdd(cell.item);
        }
    }
    return out;
}

function _getInfoPanelBuildingTypeKey(e) {
    if (!e) return 'unknown';
    if (e.type === 'barrack') return `barrack:${String(e.unitType || '')}`;
    if (e instanceof Tower) return `tower:${String(e.type || '')}`;
    return String(e.type || 'unknown');
}

function _getInfoPanelBuildingFilterKeys(e) {
    let keys = new Set();
    if (!e) return keys;

    let panelKey = String(_getInfoPanelBuildingTypeKey(e) || '').toLowerCase();
    if (panelKey) keys.add(panelKey);

    let rawType = String((e && e.type) || '').toLowerCase();
    if (rawType) keys.add(rawType);

    let statsType = typeof getEntityStatsCalcType === 'function'
        ? String(getEntityStatsCalcType(e) || '').toLowerCase()
        : '';
    if (statsType) keys.add(statsType);

    if (e.type === 'barrack') {
        let unitType = String(e.unitType || '').toLowerCase();
        if (unitType) {
            keys.add(`barrack:${unitType}`);
            keys.add(`barrack_${unitType}`);
        }
    }
    return keys;
}

function _isInfoPanelBuildingIdleLike(e) {
    if (!e) return false;
    if (e.underConstruction || e.isUpgrading || e.isStacking || e.isResearching) return false;
    if (Array.isArray(e.spawnQueue) && e.spawnQueue.length > 0) return false;
    return true;
}

function _getInfoPanelRosterThumbSpec(domain, filterKey) {
    let which = String(domain || '').toLowerCase();
    let key = String(filterKey || '').toLowerCase();
    if (!key || key === 'total') return null;
    if (which === 'units') {
        return { thumbKey: filterKey, isUnit: true };
    }
    if (which !== 'buildings') return null;
    if (key.startsWith('barrack_')) {
        return { thumbKey: filterKey, isUnit: false };
    }
    if (key.startsWith('barrack:')) {
        return { thumbKey: `barrack_${filterKey.slice(8)}`, isUnit: false };
    }
    if (key.startsWith('barrack:')) {
        return { thumbKey: `barrack_${filterKey.slice(8)}`, isUnit: false };
    }
    if (key.startsWith('tower:')) {
        return { thumbKey: filterKey.slice(6), isUnit: false };
    }
    return { thumbKey: filterKey, isUnit: false };
}

function _buildInfoPanelRosterRow(domain, filterKey, label, idleValue, totalValue, noun) {
    let titleBase = `${String(label).toLowerCase()} ${noun}`;
    let thumb = _getInfoPanelRosterThumbSpec(domain, filterKey);
    let borderRadius = thumb && thumb.isUnit ? '50%' : '4px';
    let mainButtonHtml = thumb
        ? `<button type="button" class="info-player-status-select-btn" data-domain="${domain}" data-filter="${filterKey}" data-mode="all" style="width:22px;height:22px;padding:0;border:1px solid #333;border-radius:${borderRadius};background:#111;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto" title="Select all ${titleBase}"><img src="${getItemThumbnail(thumb.thumbKey, 18)}" width="18" height="18" style="display:block;${thumb.isUnit ? 'border-radius:50%;' : 'border-radius:3px;'}"></button>`
        : `<button type="button" class="info-player-status-select-btn" data-domain="${domain}" data-filter="${filterKey}" data-mode="all" style="cursor:pointer;color:#bbb;width:40px;min-width:40px;max-width:40px;height:22px;text-align:center;background:#161616;border:1px solid #333;border-radius:3px;padding:0;font:inherit;line-height:1" title="Select all ${titleBase}">${label}</button>`;
    return `<div class="info-row" style="margin:0;gap:4px;align-items:center">`
        + `<span style="display:inline-flex;align-items:center;gap:4px;flex:0 0 103px;min-width:103px;max-width:103px">`
        + `<span style="display:inline-flex;align-items:center;justify-content:center;flex:0 0 40px;min-width:40px;max-width:40px">${mainButtonHtml}</span>`
        + `<button type="button" class="info-player-status-select-btn" data-domain="${domain}" data-filter="${filterKey}" data-mode="idle" style="cursor:pointer;color:#ddd;width:35px;min-width:35px;max-width:35px;height:20px;text-align:center;background:#161616;border:1px solid #333;border-radius:3px;padding:0;font:inherit;line-height:1" title="Select idle ${titleBase}">Idle</button>`
        + `<button type="button" class="info-player-status-select-btn" data-domain="${domain}" data-filter="${filterKey}" data-mode="one" style="cursor:pointer;color:#ddd;width:20px;min-width:20px;max-width:20px;height:20px;text-align:center;background:#161616;border:1px solid #333;border-radius:3px;padding:0;font:inherit;line-height:1" title="Select one ${titleBase} (prefer idle)">1</button>`
        + `</span>`
        + `<span class="info-value" style="color:#ddd;flex:0 0 72px;min-width:72px;padding-left:6px;text-align:right;font-variant-numeric:tabular-nums">${idleValue} / ${totalValue}</span>`
        + `</div>`;
}

function selectInfoPanelPlayerRoster(domain, filterKey, mode, owner = localPlayerId) {
    let which = String(domain || '').toLowerCase();
    let filter = String(filterKey || 'total').toLowerCase();
    let selectMode = String(mode || 'all').toLowerCase();

    let nextUnits = [];
    let nextEntities = [];
    if (which === 'all-owned') {
        nextUnits = _getOwnedInfoPanelUnits(owner);
        nextEntities = _getOwnedInfoPanelBuildings(owner);
    } else if (which === 'units') {
        let pool = _getOwnedInfoPanelUnits(owner);
        if (filter !== 'total') pool = pool.filter(u => String(u.unitType || '').toLowerCase() === filter);
        let idlePool = pool.filter(_isInfoPanelUnitIdleLike);
        if (selectMode === 'idle') nextUnits = idlePool;
        else if (selectMode === 'one') nextUnits = [(idlePool.length > 0 ? idlePool : pool)[Math.floor(Math.random() * (idlePool.length > 0 ? idlePool.length : pool.length))]].filter(Boolean);
        else nextUnits = pool;
    } else if (which === 'buildings') {
        let pool = _getOwnedInfoPanelBuildings(owner);
        if (filter !== 'total') pool = pool.filter(e => _getInfoPanelBuildingFilterKeys(e).has(filter));
        let idlePool = pool.filter(_isInfoPanelBuildingIdleLike);
        if (selectMode === 'idle') nextEntities = idlePool;
        else if (selectMode === 'one') nextEntities = [(idlePool.length > 0 ? idlePool : pool)[Math.floor(Math.random() * (idlePool.length > 0 ? idlePool.length : pool.length))]].filter(Boolean);
        else nextEntities = pool;
    } else if (which === 'upkeep-total') {
        nextUnits = _getOwnedInfoPanelUnits(owner);
        nextEntities = _getOwnedInfoPanelBuildings(owner);
    } else if (which === 'upkeep-units') {
        let pool = _getOwnedInfoPanelUnits(owner);
        if (filter !== 'total') pool = pool.filter(u => String(u.unitType || '').toLowerCase() === filter);
        nextUnits = pool;
    } else if (which === 'upkeep-buildings') {
        let pool = _getOwnedInfoPanelBuildings(owner);
        if (filter !== 'total') {
            pool = pool.filter(e => _getInfoPanelBuildingFilterKeys(e).has(filter));
        }
        nextEntities = pool;
    }

    if (nextUnits.length <= 0 && nextEntities.length <= 0) return false;
    selectedUnits = nextUnits;
    selectedEntities = nextEntities;
    activeSubGroups = {};
    updateInfoPanel();
    return true;
}

function buildInfoPanelIdleWorkersHtml(owner) {
    if (!Number.isFinite(owner) || owner < 0 || owner >= players.length) return '';

    let ownedUnits = _getOwnedInfoPanelUnits(owner);
    let ownedBuildings = _getOwnedInfoPanelBuildings(owner);

    let unitGroups = new Map();
    for (let u of ownedUnits) {
        let key = String(u.unitType || 'other');
        let entry = unitGroups.get(key);
        if (!entry) {
            entry = { label: _prettyUnitTypeLabel(key), total: 0, idle: 0 };
            unitGroups.set(key, entry);
        }
        entry.total++;
        if (_isInfoPanelUnitIdleLike(u)) entry.idle++;
    }

    let buildingGroups = new Map();
    for (let e of ownedBuildings) {
        let key = _getInfoPanelBuildingTypeKey(e);
        let entry = buildingGroups.get(key);
        if (!entry) {
            entry = { label: getEntityGroupLabel(e), total: 0, idle: 0 };
            buildingGroups.set(key, entry);
        }
        entry.total++;
        if (_isInfoPanelBuildingIdleLike(e)) entry.idle++;
    }

    let unitIdleTotal = ownedUnits.filter(_isInfoPanelUnitIdleLike).length;
    let buildingIdleTotal = ownedBuildings.filter(_isInfoPanelBuildingIdleLike).length;

    let unitHeaderControls = _buildInfoPanelRosterModeButtonHtml('units', 'total', 'all', 'All', 'Select all units', 28)
        + _buildInfoPanelRosterModeButtonHtml('units', 'total', 'idle', 'Idle', 'Select idle units', 35)
        + `<span class="info-value" style="color:#ddd;flex:0 0 72px;min-width:72px;padding-left:6px;text-align:right;font-variant-numeric:tabular-nums">${unitIdleTotal} / ${ownedUnits.length}</span>`;
    let html = _buildCollapsibleInfoSectionTitle('units', 'Units', unitHeaderControls);
    if (!_isInfoSectionCollapsed('units')) {
        let sortedUnitTypes = Array.from(unitGroups.keys()).sort(_compareInfoPanelUnitTypes);
        for (let unitType of sortedUnitTypes) {
            let entry = unitGroups.get(unitType);
            html += _buildInfoPanelRosterRow('units', unitType, entry.label, entry.idle, entry.total, 'units');
        }
    }
    html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;

    let buildingHeaderControls = _buildInfoPanelRosterModeButtonHtml('buildings', 'total', 'all', 'All', 'Select all buildings', 28)
        + _buildInfoPanelRosterModeButtonHtml('buildings', 'total', 'idle', 'Idle', 'Select idle buildings', 35)
        + `<span class="info-value" style="color:#ddd;flex:0 0 72px;min-width:72px;padding-left:6px;text-align:right;font-variant-numeric:tabular-nums">${buildingIdleTotal} / ${ownedBuildings.length}</span>`;
    html += _buildCollapsibleInfoSectionTitle('buildings', 'Buildings', buildingHeaderControls);
    if (!_isInfoSectionCollapsed('buildings')) {
        let sortedBuildingTypes = Array.from(buildingGroups.keys()).sort((a, b) => {
            let aLabel = (buildingGroups.get(a) || {}).label || a;
            let bLabel = (buildingGroups.get(b) || {}).label || b;
            return String(aLabel).localeCompare(String(bLabel));
        });
        for (let typeKey of sortedBuildingTypes) {
            let entry = buildingGroups.get(typeKey);
            html += _buildInfoPanelRosterRow('buildings', typeKey, entry.label, entry.idle, entry.total, 'buildings');
        }
    }
    html += `<div style="border-bottom:1px solid #333;margin:4px 0"></div>`;
    return html;
}

function _getInfoPanelUnitStateLabel(u) {
    return ['Idle', 'Move', 'AtkMove', 'Attack', 'Hold'][Number(u && u.commandState) || 0] || 'Idle';
}

function _getInfoPanelWorkerSearchDistanceText(u) {
    if (!u || !u.workerType) return 'nearby';
    let lvl = Math.max(1, getUnitEffectiveLevel(u, getUnitBaseLevel(u)));
    let areas = Number(getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance'));
    if (!Number.isFinite(areas) || areas <= 0) areas = 2.0;
    return `${Math.max(0, Math.floor(areas))}a`;
}

function formatAreaDistanceStat(v) {
    return Number.isFinite(v) ? `${Math.max(0, Math.floor(Number(v)))}a` : '-';
}

function _getInfoPanelUnitStateHelpText(u) {
    if (!u) return 'Current unit order and why it is happening.';

    if (Number.isFinite(u._astarBudgetBlockedUntil) && gameTime < u._astarBudgetBlockedUntil) {
        if (u.commandState === CMD_MOVING || u.commandState === CMD_ATTACK_MOVING || u.commandState === CMD_ATTACKING) {
            return 'Moving under A* debt. Negative A* now reduces unit speed through the owner precomputed stat map until the stockpile recovers.';
        }
    }

    if (u.commandState === CMD_HOLDING) {
        if (u.workerType) return 'Holding because hold was used. Press X to release hold and let worker auto-AI resume.';
        return 'Holding position. The unit only fights in place until you give a new order or press X.';
    }

    if (u.workerType) {
        let searchRange = _getInfoPanelWorkerSearchDistanceText(u);
        if (u.workerState === 'MANUAL_MOVE') {
            return 'Manual move or rally order is active, so automatic worker retargeting is paused. Press X to stop or give a new work order.';
        }
        if (u.workerState === 'IDLE') {
            if (Number.isFinite(u._energyBlockedUntil) && gameTime < u._energyBlockedUntil) {
                return 'Idle because the worker could not afford its next material or energy pickup. Add more income or wait for resources.';
            }
            if (Number.isFinite(u._astarBudgetBlockedUntil) && gameTime < u._astarBudgetBlockedUntil) {
                return 'Idle because A* was exhausted recently. Wait for more A* income or reduce pathfinding demand.';
            }
            return `Idle because no valid work was found within range (${searchRange}). Build relevant work closer, raise Work Distance, or give a manual order.`;
        }
        if (u.workerState === 'RETURNING' || u.workerState === 'RETURNING_ASTAR') {
            return 'Returning carried resources to the nearest drop-off before choosing the next task.';
        }
        if (u.workerState === 'RETURNING_FOR_GOLD') {
            return 'Fetching materials or supplies from the nearest provider before returning to the current task.';
        }
        if (u.workerState === 'MOVING_TO' || u.workerState === 'MOVING_TO_ASTAR' || u.workerState === 'MOVING_TO_BUILD' || u.workerState === 'MOVING_TO_HEAL' || u.workerState === 'MOVING_TO_RESEARCH') {
            return 'Moving toward the current assigned task target.';
        }
        if (u.workerState === 'BUILDING_IN_PLACE') {
            return 'Working on the current build site without making a material trip. Add more energy or a better route to restore full throughput.';
        }
        if (u.workerState === 'HEALING') {
            return 'Applying healing to the current target. The worker will fetch more supplies after this trip if needed.';
        }
        if (u.workerState === 'RESEARCHING') {
            return 'Applying research work to the active lab task. The worker will fetch more materials after this trip if needed.';
        }
    }

    if (u.commandState === CMD_IDLE) return 'No active order right now. Give a move, attack-move, attack, or hold command.';
    if (u.commandState === CMD_MOVING) return 'Moving toward the current destination.';
    if (u.commandState === CMD_ATTACK_MOVING) return 'Attack-moving: advancing while auto-engaging enemies on the way.';
    if (u.commandState === CMD_ATTACKING) return 'Attacking or chasing the current target.';
    return 'Current unit order and why it is happening.';
}

function _buildInfoPanelUnitStateLabel(u) {
    return _buildInfoPanelStateLabelButton(_getInfoPanelUnitStateLabel(u), _getInfoPanelUnitStateHelpText(u));
}

function _buildInfoPanelStateLabelButton(stateLabel, helpText) {
    let help = _escapeHtml(String(helpText || 'Current state and why it is happening.'));
    let label = _escapeHtml(String(stateLabel || 'State'));
    return `<span style="display:inline-flex;align-items:center;gap:4px;"><button type="button" class="info-state-help-btn" data-state-label="${label}" data-help-text="${help}" title="Open state help" style="cursor:pointer;background:#1a2631;color:#cfe6ff;border:1px solid #486179;border-radius:3px;font-size:10px;padding:0 4px;line-height:1.2">S</button><span>State</span></span>`;
}

function _getInfoPanelEntityStateLabel(e, includeResearch = false) {
    return getEntityStatusText(e, includeResearch);
}

function _getInfoPanelEntityStateHelpText(e, includeResearch = false) {
    if (!e) return 'Current thing state and why it is happening.';
    let baseMsg = '';
    if (e.underConstruction) baseMsg = 'Under construction. Builders are still delivering and applying build progress.';
    else if (includeResearch && e.isResearching) baseMsg = 'Actively running research work right now.';
    else if (e.isUpgrading) baseMsg = 'Upgrading to a higher level. This consumes build progress/resources until complete.';
    else if (e.isStacking) baseMsg = 'Stacking toward higher level requirements.';
    else if (Array.isArray(e.spawnQueue) && e.spawnQueue.length > 0) baseMsg = `Ready, with ${e.spawnQueue.length} unit(s) waiting in the spawn queue.`;
    else if (Number.isFinite(e.energy) && e.energy <= 0) baseMsg = 'Not operational because energy is empty.';
    else baseMsg = 'Ready and operational.';
    
    let maxLevelMsg = _getMaxLevelBlockedMessage(e);
    if (maxLevelMsg) baseMsg += ' ' + maxLevelMsg;
    return baseMsg;
}

function _buildInfoPanelEntityStateLabel(e, includeResearch = false) {
    return _buildInfoPanelStateLabelButton(_getInfoPanelEntityStateLabel(e, includeResearch), _getInfoPanelEntityStateHelpText(e, includeResearch));
}

function _getMaxLevelBlockedMessage(e) {
    if (!e) return '';
    let currentLevel = e.level || stackCountToLevel(e.stacks || 1);
    let potLevel = getThingPotentialLevel(e, Math.max(1, getThingEffectiveLevel(e)));
    let researchMax = getThingResearchedMaxLevel(e);
    // Show message if: potential exceeds research max, and we're at or near max already
    if (potLevel > researchMax && currentLevel >= researchMax) {
        return 'Cannot upgrade further. Increase Max Level in the Research building.';
    }
    return '';
}

function _buildInfoPanelAssignedLabelButton(mode, dataAttrs = {}) {
    let attrs = '';
    for (let [k, v] of Object.entries(dataAttrs || {})) {
        if (v === undefined || v === null) continue;
        attrs += ` data-${_escapeHtml(String(k))}="${_escapeHtml(String(v))}"`;
    }
    return `<span style="display:inline-flex;align-items:center;gap:4px;"><button type="button" class="info-assigned-open-popup-btn" data-mode="${_escapeHtml(String(mode || ''))}"${attrs} title="Open assigned in popup" style="cursor:pointer;background:#1a2631;color:#cfe6ff;border:1px solid #486179;border-radius:3px;font-size:10px;padding:0 4px;line-height:1.2">A</button><span>Assigned</span></span>`;
}

function _findInfoPanelUnitById(unitId) {
    let id = Math.floor(Number(unitId));
    if (!Number.isFinite(id)) return null;
    for (let i = 0; i < units.length; i++) {
        let u = units[i];
        if (u && !u.dead && Math.floor(Number(u.id)) === id) return u;
    }
    return null;
}

function _resolveInfoPanelEntityAt(gx, gy, targetType = '') {
    let x = Math.floor(Number(gx));
    let y = Math.floor(Number(gy));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (targetType === 'mine') {
        let mine = getGoldMineAt(x, y);
        if (mine) return mine;
    }
    if (targetType === 'astar_mine') {
        let mine = getAstarMineAt(x, y);
        if (mine) return mine;
    }
    let ref = getTileEntityRef(x, y);
    if (ref) return ref;
    return getGoldMineAt(x, y) || getAstarMineAt(x, y) || null;
}

function _selectInfoPanelAssignedUnit(unitId) {
    let u = _findInfoPanelUnitById(unitId);
    if (!u) return;
    selectedUnits = [u];
    selectedEntities = [];
    activeSubGroups = {};
    updateInfoPanel();
}

function _selectInfoPanelAssignedTarget(gx, gy, targetType = '') {
    let e = _resolveInfoPanelEntityAt(gx, gy, targetType);
    if (!e) return;
    selectedEntities = [e];
    selectedUnits = [];
    activeSubGroups = {};
    updateInfoPanel();
}

function _openAssignedInPopupForEntity(gx, gy, targetType = '') {
    let e = _resolveInfoPanelEntityAt(gx, gy, targetType);
    if (!e) return;
    let assigned = [];
    for (let i = 0; i < units.length; i++) {
        let u = units[i];
        if (!u || u.dead || !u.workerType) continue;
        if (u.workerTarget !== e) continue;
        assigned.push(u);
    }
    if (assigned.length <= 0) return;
    selectedEntities = [];
    selectedUnits = assigned;
    activeSubGroups = {};
    setResearchPopupOpen(true);
    updateInfoPanel();
}

function _openAssignedInPopupForWorker(workerId) {
    let u = _findInfoPanelUnitById(workerId);
    if (!u || !u.workerType || !u.workerTarget) return;
    let target = u.workerTarget;
    let targetType = String(u.workerTargetType || '');
    if (target.unitType && Number.isFinite(target.id)) {
        let tu = _findInfoPanelUnitById(target.id);
        if (!tu) return;
        selectedEntities = [];
        selectedUnits = [tu];
        activeSubGroups = {};
        setResearchPopupOpen(true);
        updateInfoPanel();
        return;
    }
    let gx = Number(target.gx);
    let gy = Number(target.gy);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return;
    let e = _resolveInfoPanelEntityAt(gx, gy, targetType);
    if (!e) return;
    selectedUnits = [];
    selectedEntities = [e];
    activeSubGroups = {};
    setResearchPopupOpen(true);
    updateInfoPanel();
}

function _getInfoPanelThingThumbKey(ref, targetType = '') {
    if (!ref) return '';
    if (ref.unitType) return String(ref.unitType);
    if (ref._isGoldMine || targetType === 'mine' || (Number.isFinite(ref.gold) && Number.isFinite(ref.maxGold))) return 'goldmine';
    if (ref._isAstarMine || targetType === 'astar_mine' || (Number.isFinite(ref.astar) && Number.isFinite(ref.maxAstar))) return 'astarmine';
    if (ref.type === 'barrack' && ref.unitType) return `barrack_${ref.unitType}`;
    if (ref.type) return String(ref.type);
    if (targetType === 'farm') return 'farm';
    if (targetType === 'astar_farm') return 'astar_farm';
    return '';
}

function _getInfoPanelThingTitle(ref, targetType = '') {
    if (!ref) return 'Assigned target';
    if (ref.unitType) return `${String(ref.unitType).replace(/_/g, ' ')} #${Math.floor(Number(ref.id) || 0)}`;
    if (ref._isGoldMine || targetType === 'mine' || (Number.isFinite(ref.gold) && Number.isFinite(ref.maxGold))) return 'Gold Mine';
    if (ref._isAstarMine || targetType === 'astar_mine' || (Number.isFinite(ref.astar) && Number.isFinite(ref.maxAstar))) return 'A* Mine';
    if (ref.type === 'barrack' && ref.unitType) return `Barrack (${ref.unitType})`;
    if (ref.type) return String(ref.type).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return 'Assigned target';
}

function _buildInfoPanelAssignedWorkersHtml(e) {
    let wrapStart = '<span style="display:inline-flex;align-items:center;gap:3px;flex-wrap:nowrap;height:16px;overflow:hidden;white-space:nowrap;vertical-align:middle;line-height:0">';
    let wrapEnd = '</span>';
    if (!e) return `${wrapStart}<span style="color:#9aa;line-height:1">None</span>${wrapEnd}`;
    let assigned = [];
    for (let i = 0; i < units.length; i++) {
        let u = units[i];
        if (!u || u.dead || !u.workerType) continue;
        if (u.workerTarget !== e) continue;
        assigned.push(u);
    }
    if (assigned.length === 0) return `${wrapStart}<span style="color:#9aa;line-height:1">None</span>${wrapEnd}`;
    let maxVisible = 8;
    let html = wrapStart;
    for (let i = 0; i < assigned.length && i < maxVisible; i++) {
        let u = assigned[i];
        let thumb = getItemThumbnail(u.unitType, 14);
        let title = _escapeHtml(_getInfoPanelThingTitle(u));
        html += `<button type="button" class="info-assigned-unit-btn" data-unit-id="${u.id}" title="${title}" style="cursor:pointer;background:#151515;border:1px solid #3f4f5f;border-radius:3px;padding:0;width:16px;height:16px;min-width:16px;display:inline-flex;align-items:center;justify-content:center">`;
        html += `<img src="${thumb}" width="12" height="12" style="display:block;border-radius:50%">`;
        html += `</button>`;
    }
    if (assigned.length > maxVisible) {
        html += `<span title="${assigned.length - maxVisible} more assigned" style="display:inline-flex;align-items:center;justify-content:center;height:16px;min-width:16px;padding:0 4px;background:#1a1a1a;border:1px solid #3f4f5f;border-radius:3px;color:#9fb2c7;font-size:9px;line-height:1">+${assigned.length - maxVisible}</span>`;
    }
    html += wrapEnd;
    return html;
}

function _buildInfoPanelWorkerAssignedTargetHtml(u) {
    let wrapStart = '<span style="display:inline-flex;align-items:center;gap:3px;flex-wrap:nowrap;height:16px;overflow:hidden;white-space:nowrap;vertical-align:middle;line-height:0">';
    let wrapEnd = '</span>';
    if (!u || !u.workerType) return `${wrapStart}<span style="color:#9aa;line-height:1">None</span>${wrapEnd}`;
    let target = u.workerTarget;
    let targetType = String(u.workerTargetType || '');
    if (!target) return `${wrapStart}<span style="color:#9aa;line-height:1">None</span>${wrapEnd}`;

    if (target.unitType && Number.isFinite(target.id)) {
        let title = _escapeHtml(_getInfoPanelThingTitle(target));
        return wrapStart
            + `<button type="button" class="info-assigned-unit-btn" data-unit-id="${target.id}" title="${title}" style="cursor:pointer;background:#151515;border:1px solid #3f4f5f;border-radius:3px;padding:0;width:16px;height:16px;min-width:16px;display:inline-flex;align-items:center;justify-content:center">`
            + `<img src="${getItemThumbnail(target.unitType, 14)}" width="12" height="12" style="display:block;border-radius:50%">`
            + `</button>`
            + wrapEnd;
    }

    let gx = Number(target.gx);
    let gy = Number(target.gy);
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) return `${wrapStart}<span style="color:#9aa;line-height:1">None</span>${wrapEnd}`;

    let thumbKey = _getInfoPanelThingThumbKey(target, targetType);
    let title = _escapeHtml(_getInfoPanelThingTitle(target, targetType));
    let imgHtml = thumbKey
        ? `<img src="${getItemThumbnail(thumbKey, 14)}" width="12" height="12" style="display:block;${targetType.indexOf('mine') >= 0 ? '' : 'border-radius:3px;'}">`
        : '<span style="color:#9cf">T</span>';
    return wrapStart + `<button type="button" class="info-assigned-target-btn" data-target-gx="${Math.floor(gx)}" data-target-gy="${Math.floor(gy)}" data-target-type="${_escapeHtml(targetType)}" title="${title}" style="cursor:pointer;background:#151515;border:1px solid #3f4f5f;border-radius:3px;padding:0;width:16px;height:16px;min-width:16px;display:inline-flex;align-items:center;justify-content:center">`
        + imgHtml
        + `</button>` + wrapEnd;
}

function updateHUD() {
    if (!_hudEls.energy) {
        _hudEls.energy = document.getElementById('hud-energy');
        _hudEls.astar = document.getElementById('hud-astar');
        _hudEls.pop = document.getElementById('hud-pop');
        _hudEls.time = document.getElementById('hud-time');
        _hudEls.fps = document.getElementById('hud-fps');
        _bindHudResourcePopupTrigger(_hudEls.energy, 'energy');
        _bindHudResourcePopupTrigger(_hudEls.astar, 'astar');
    }
    let p = players[localPlayerId];
    let energy = Math.floor(p.energy);
    _renderHudResource(_hudEls.energy, 'energy', localPlayerId, 'energy', '⚡', '#da0', energy);
    let astarCur = Math.floor(_getPlayerAstarBudgetRemaining(localPlayerId));
    _renderHudResource(_hudEls.astar, 'astarText', localPlayerId, 'astar', '★', '#9aa', astarCur);
    refreshResourcePenaltyPopupContent(localPlayerId);
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
        let upKeep = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'upKeep');
        let atk = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'atk');
        let cd = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'atkCd');
        let speed = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'speed');
        let range = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'attackRange');
        let vision = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'visionRange');
        let workerSearchDistance = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'workerSearchDistance');
        let gatherPerTrip = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'gatherPerTrip');
        let builderDps = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'builderDps');
        let healerDps = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'healerDps');
        let researcherDps = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'researcherDps');
        let transferCooldown = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'transferCooldown');
        let astarCost = getUnitStatForOwner(localPlayerId, unitType, safeLvl, 'astarCost');
        return {
            energy: Math.max(1, Math.floor(Number(energy) || 1)),
            upKeep: Math.max(0, Number(upKeep) || 0),
            atk: Math.max(0, Math.floor(Number(atk) || 0)),
            cd: Math.max(0.05, Number(cd) || 0.05),
            speed: Math.max(0.1, Number(speed) || 0.1),
            range: Math.max(0, Number(range) || 0),
            vision: Math.max(0.1, Number(vision) || 0.1),
            workerSearchDistance: Math.max(0, Number(workerSearchDistance) || 0),
            gatherPerTrip: Math.max(0, Number(gatherPerTrip) || 0),
            builderDps: Math.max(0, Number(builderDps) || 0),
            healerDps: Math.max(0, Number(healerDps) || 0),
            researcherDps: Math.max(0, Number(researcherDps) || 0),
            transferCooldown: Math.max(0.01, Number(transferCooldown) || Number((BASE_UNIT_STATS[unitType] || {}).transferCooldown) || 0.01),
            astarCost: Math.max(0, Number(astarCost) || 0)
        };
    };

    addRow('Stacks', `x${stacks}`, {
        getValue: (thingLevel) => `x${getRequiredStacksForLevel(thingLevel)}`
    });
    addRow('Level', `L${level}`, {
        getValue: (thingLevel, researchLevel) => getLevelMatrixCostWorkText(thingLevel, researchLevel)
    });
    let shopMaxLevel = getResearchCurrentStatValue(localPlayerId, 'building', key, 'maxLevel');
    if (Number.isFinite(shopMaxLevel)) addRow('Max Level', `L${Math.floor(shopMaxLevel)}`, { kind: 'building', key, statKey: 'maxLevel' });

    if (key.startsWith('barrack_')) {
        let unitType = def.unitType || 'norm';
        let bStats = calculateItemStats(key, level, localPlayerId);
        let buildingUpKeep = getBuildingStatForOwner(localPlayerId, key, level, 'upKeep');
        let up = getUnitPreview(unitType, level);
        let buildingVisibility = getBuildingStatForOwner(localPlayerId, key, level, 'visionRange');
        if (!Number.isFinite(buildingVisibility)) buildingVisibility = Number((BASE_CARD_TYPES[key] || {}).visionRange);
        addRow('Energy', `${fmt(bStats.maxEnergy)}/${fmt(bStats.maxEnergy)}`, { kind: 'building', key, statKey: 'maxEnergy' });
        if (Number.isFinite(buildingUpKeep)) addRow('UpKeep', `${fmt(buildingUpKeep, 2)}\u26A1/ s`, { kind: 'building', key, statKey: 'upKeep' });
        if (Number.isFinite(buildingVisibility)) addRow('Visibility', formatAreaDistanceStat(buildingVisibility), { kind: 'building', key, statKey: 'visionRange' });
        addRow('Unit Energy', fmt(up.energy), { kind: 'unit', key: unitType, statKey: 'energy' });
        addRow('Unit UpKeep', `${fmt(up.upKeep, 2)}\u26A1/ s`, { kind: 'unit', key: unitType, statKey: 'upKeep' });
        if (unitType === 'builder_unit') addRow('Work Speed', `${fmt(up.builderDps, 1)}\u26A1`, { kind: 'unit', key: unitType, statKey: 'builderDps' });
        else if (unitType === 'healer_unit') addRow('Work Speed', `${fmt(up.healerDps, 1)}\u26A1`, { kind: 'unit', key: unitType, statKey: 'healerDps' });
        else if (unitType === 'collector') addRow('Work Speed', `${fmt(up.gatherPerTrip, 1)}\u26A1`, { kind: 'unit', key: unitType, statKey: 'gatherPerTrip' });
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
        addRow('Unit Range', formatAreaDistanceStat(up.range), { kind: 'unit', key: unitType, statKey: 'attackRange' });
        addRow('Unit Visibility', formatAreaDistanceStat(up.vision), { kind: 'unit', key: unitType, statKey: 'visionRange' });
        addRow('Unit Speed', up.speed.toFixed(1), { kind: 'unit', key: unitType, statKey: 'speed' });
        addRow('Unit ★ / Tile', fmt(up.astarCost, 1), { kind: 'unit', key: unitType, statKey: 'astarCost' });
        if (up.workerSearchDistance > 0) addRow('Work Distance', formatAreaDistanceStat(up.workerSearchDistance), { kind: 'unit', key: unitType, statKey: 'workerSearchDistance' });
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
        let buildingUpKeep = getBuildingStatForOwner(localPlayerId, key, level, 'upKeep');
        let up = getUnitPreview(workerType, level);
        addRow('Energy', `${fmt(stats.maxEnergy)}/${fmt(stats.maxEnergy)}`, { kind: 'building', key, statKey: 'maxEnergy' });
        if (Number.isFinite(buildingUpKeep)) addRow('UpKeep', `${fmt(buildingUpKeep, 2)}\u26A1/ s`, { kind: 'building', key, statKey: 'upKeep' });
        addRow(key === 'research' ? 'Researcher Energy' : 'Worker Energy', fmt(up.energy), { kind: 'unit', key: workerType, statKey: 'energy' });
        addRow('Worker UpKeep', `${fmt(up.upKeep, 2)}\u26A1/ s`, { kind: 'unit', key: workerType, statKey: 'upKeep' });
        if (workerType === 'builder_unit') addRow('Work Speed', `${fmt(up.builderDps, 1)}\u26A1`, { kind: 'unit', key: workerType, statKey: 'builderDps' });
        else if (workerType === 'healer_unit') addRow('Work Speed', `${fmt(up.healerDps, 1)}\u26A1`, { kind: 'unit', key: workerType, statKey: 'healerDps' });
        else if (workerType === 'researcher_unit') addRow('Work Speed', `${fmt(up.researcherDps, 1)}\u26A1`, { kind: 'unit', key: workerType, statKey: 'researcherDps' });
        else if (workerType === 'collector') addRow('Work Speed', `${fmt(up.gatherPerTrip, 1)}\u26A1`, { kind: 'unit', key: workerType, statKey: 'gatherPerTrip' });
        else if (workerType === 'astar_collector') addRow('Work Speed', `${fmt(up.gatherPerTrip, 1)}\u26A1`, { kind: 'unit', key: workerType, statKey: 'gatherPerTrip' });
        else addRow('Salvage Yield', `10% x L${level}`);
        addRow('Transfer CD', `${up.transferCooldown.toFixed(2)}s`, { kind: 'unit', key: workerType, statKey: 'transferCooldown' });
        let buildingVisibility = getBuildingStatForOwner(localPlayerId, key, level, 'visionRange');
        if (!Number.isFinite(buildingVisibility)) buildingVisibility = Number((BASE_CARD_TYPES[key] || {}).visionRange);
        if (Number.isFinite(buildingVisibility)) addRow('Visibility', formatAreaDistanceStat(buildingVisibility), { kind: 'building', key, statKey: 'visionRange' });
        addRow(key === 'research' ? 'Researcher Visibility' : 'Worker Visibility', formatAreaDistanceStat(up.vision), { kind: 'unit', key: workerType, statKey: 'visionRange' });
        addRow('Speed', up.speed.toFixed(1), { kind: 'unit', key: workerType, statKey: 'speed' });
        addRow(key === 'research' ? 'Researcher ★ / Tile' : 'Worker ★ / Tile', fmt(up.astarCost, 1), { kind: 'unit', key: workerType, statKey: 'astarCost' });
        if (up.workerSearchDistance > 0) addRow('Work Distance', formatAreaDistanceStat(up.workerSearchDistance), { kind: 'unit', key: workerType, statKey: 'workerSearchDistance' });
        if (key === 'research') {
            let efficiency = getBuildingStatForOwner(localPlayerId, key, level, 'efficiency');
            if (Number.isFinite(efficiency)) addRow('Efficiency', efficiency.toFixed(2), { kind: 'building', key, statKey: 'efficiency' });
        }
    } else if (def.target === 'wall') {
        let energy = getBuildingStatForOwner(localPlayerId, key, level, 'maxEnergy');
        let dmg = getBuildingStatForOwner(localPlayerId, key, level, 'damage');
        let cd = getBuildingStatForOwner(localPlayerId, key, level, 'cd');
        let upKeep = getBuildingStatForOwner(localPlayerId, key, level, 'upKeep');
        let vision = getBuildingStatForOwner(localPlayerId, key, level, 'visionRange');
        if (!Number.isFinite(energy)) energy = Math.floor((def.towerEnergy || 0) * Math.pow(1.4, level - 1));
        if (!Number.isFinite(dmg)) dmg = null;
        if (!Number.isFinite(cd)) cd = def.cd;
        if (!Number.isFinite(vision)) vision = def.visionRange;
        if (energy > 0) addRow('Energy', `${fmt(energy)}/${fmt(energy)}`, { kind: 'building', key, statKey: 'maxEnergy' });
        if (Number.isFinite(upKeep)) addRow('UpKeep', `${fmt(upKeep, 2)}\u26A1/ s`, { kind: 'building', key, statKey: 'upKeep' });
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
            if (vision !== undefined) addRow('Visibility', formatAreaDistanceStat(Number(vision)), { kind: 'building', key, statKey: 'visionRange' });
        } else if (vision !== undefined) {
            addRow('Range', formatAreaDistanceStat(Number(vision)), { kind: 'building', key, statKey: 'visionRange' });
            addRow('Visibility', formatAreaDistanceStat(Number(vision)), { kind: 'building', key, statKey: 'visionRange' });
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
                    addRow('Blast Radius', formatAreaDistanceStat(blastRadius), { kind: 'building', key, statKey: 'blastRadius' });
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
        let upKeep = getBuildingStatForOwner(localPlayerId, key, level, 'upKeep');
        if (stats.maxEnergy > 0) addRow('Energy', `${fmt(stats.maxEnergy)}/${fmt(stats.maxEnergy)}`, { kind: 'building', key, statKey: 'maxEnergy' });
        if (Number.isFinite(upKeep)) addRow('UpKeep', `${fmt(upKeep, 2)}\u26A1/ s`, { kind: 'building', key, statKey: 'upKeep' });
            if (key === 'farm' || key === 'astar_farm') {
                let multiplier = Number.isFinite(stats.multiplier) ? stats.multiplier : level;
                let gatherLabel = 'x Work Speed';
                addRow('Multiplier', `${multiplier.toFixed(2)}${gatherLabel}`, { kind: 'building', key, statKey: 'multiplier' });
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
                addRow('Blast Radius', formatAreaDistanceStat(blastRadius), { kind: 'building', key, statKey: 'blastRadius' });
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
    return `<span class="info-disabled-pill" style="cursor:default;background:#1a1a1a;padding:2px 8px;border:1px solid #333;border-radius:3px;font-size:9px;color:#555;">${label}</span>`;
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

function getInfoPanelWorkSpeedStatKey(unitType) {
    if (unitType === 'builder_unit') return 'builderDps';
    if (unitType === 'healer_unit') return 'healerDps';
    if (unitType === 'researcher_unit') return 'researcherDps';
    if (unitType === 'collector' || unitType === 'astar_collector') return 'gatherPerTrip';
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
    } else if (plain.endsWith('upKeep')) {
        if (plain.startsWith('unit ') || plain.startsWith('worker ') || plain.startsWith('researcher ') || plain.startsWith('collector ') || plain.startsWith('builder ') || plain.startsWith('healer ') || plain.startsWith('salvager ')) {
            kind = 'unit';
            key = unitType || key;
        }
        statKey = 'upKeep';
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
    } else if (plain === 'work speed' || plain === 'heal speed' || plain === 'research speed' || plain === 'gather speed' || plain === 'a* gather') {
        kind = 'unit';
        key = unitType || key;
        statKey = getInfoPanelWorkSpeedStatKey(key);
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
    let actualLvl = getThingBaseLevel(obj, stackCountToLevel(obj && obj.stacks || 1));
    if (obj.underConstruction) actualLvl = 0;
    let effLvl = getDisplayLevel(obj);
    let potLvl = obj.underConstruction
        ? Math.max(0, Math.floor(Number(obj.potentialEffectiveLevel || effLvl || actualLvl) || 0))
        : getThingPotentialLevel(obj, Math.max(1, effLvl || actualLvl));
    let manualLvl = obj.underConstruction
        ? actualLvl
        : stackCountToLevel(getThingManualStacks(obj));
    potLvl = Math.max(potLvl, manualLvl);
    let researchedMax = (typeof getThingResearchedMaxLevel === 'function') ? getThingResearchedMaxLevel(obj) : MAX_THING_LEVEL;
    let potExceedsMax = potLvl > researchedMax;

    let html = `<span style="color:#888">L${actualLvl}</span>`;
    if (effLvl !== actualLvl && effLvl > 0) {
        html += ` <span style="color:#4f4">L${effLvl}</span>`;
    }
    if (potLvl > Math.max(actualLvl, effLvl)) {
        let arrowFrom = (effLvl !== actualLvl && effLvl > 0) ? effLvl : actualLvl;
        if (arrowFrom > 0) {
            let potColor = potExceedsMax ? '#d88' : '#f44'; // Muted red if blocked by max level
            html += `<span style="color:#aaa">-></span><span style="color:${potColor};text-decoration:${potExceedsMax ? 'line-through' : 'none'}">L${potLvl}</span>`;
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
    return `<div class="info-row"><span class="info-label">${matrixLabel}</span><span class="info-value level-display">${valueHtml}</span></div>`;
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
        return activeSubGroups[getEntityGroupKey(e)] !== false;
    });
}

function _isGoldMineLikeEntity(e) {
    if (!e) return false;
    return !!e._isGoldMine || (Number.isFinite(e.gold) && Number.isFinite(e.maxGold));
}

function _isAstarMineLikeEntity(e) {
    if (!e) return false;
    return !!e._isAstarMine || (Number.isFinite(e.astar) && Number.isFinite(e.maxAstar));
}

function getEntityGroupKey(e) {
    if (_isGoldMineLikeEntity(e)) return 'goldmine';
    if (_isAstarMineLikeEntity(e)) return 'astarmine';
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
    if (_isGoldMineLikeEntity(e)) return 'Energy Mine';
    if (_isAstarMineLikeEntity(e)) return 'A* Mine';
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
    if (_isGoldMineLikeEntity(e)) return 'goldmine';
    if (_isAstarMineLikeEntity(e)) return 'astarmine';
    if (e.type === 'barrack') return 'barrack_' + e.unitType;
    if (e instanceof Tower) return e.type;
    if (e.type === 'spawner' || e.type === 'astar_spawner' || e.type === 'salvager' || e.type === 'builder_spawner' || e.type === 'healer_spawner' || e.type === 'research') return e.type;
    if (e.type && BASE_CARD_TYPES[e.type]) return e.type;
    return null;
}

function getGroupBorderColor(grp) {
    let e = grp.items[0];
    if (grp.isUnit) return (BASE_UNIT_STATS[e.unitType] || {}).color || '#fff';
    if (_isGoldMineLikeEntity(e)) return '#fd0';
    if (_isAstarMineLikeEntity(e)) return '#bbb';
    if (e.type === 'barrack') return (BASE_UNIT_STATS[e.unitType] || {}).color || '#686';
    if (e instanceof Tower) return (BASE_CARD_TYPES[e.type] || {}).color || '#fff';
    let ct = BASE_CARD_TYPES[e.type] || {};
    return ct.color || '#fff';
}

function getGroupLevel(key, grp) {
    if (ignoreLevelSubgroups) return null;
    let e = grp.items[0];
    if (grp.isUnit) return getUnitBaseLevel(e);
    if (_isGoldMineLikeEntity(e)) return null;
    if (_isAstarMineLikeEntity(e)) return null;
    if (e.underConstruction) return 0;
    if (e.effectiveLevel !== undefined) return getThingEffectiveLevel(e);
    if (e.level !== undefined || e.stacks) return getThingBaseLevel(e);
    return null;
}

function getEntityLevelToken(e) {
    if (!e || _isGoldMineLikeEntity(e) || _isAstarMineLikeEntity(e)) return null;
    if (e.underConstruction) return 'build';
    if (e.isUpgrading) return 'upg';
    if (e.isStacking) return 'stack';
    if (e.effectiveLevel !== undefined) return `L${getThingEffectiveLevel(e)}`;
    if (e.level !== undefined || e.stacks !== undefined) return `L${getThingBaseLevel(e)}`;
    return null;
}

function getEntityEnergyDisplayMax(e) {
    if (!e) return 1;
    let effectiveMax = Math.max(1, Math.floor(getEntityEffectiveEnergyMax(e) || 1));
    let potentialMax = Math.max(effectiveMax, Math.floor((typeof getEntityPotentialEnergyMax === 'function' ? getEntityPotentialEnergyMax(e) : effectiveMax) || effectiveMax));
    return potentialMax;
}

function getThingEnergyDisplayValues(e) {
    if (!e) return { currentEnergy: 0, upgradeTriggerMax: 1, effectiveMax: 1 };
    let baseLevel = getThingBaseLevel(e, stackCountToLevel((e.stacks || 1)));
    let effectiveLevel = getThingEffectiveLevel(e, baseLevel);
    let baseMax = Math.max(1, Math.floor(getEntityBaseEnergyMax(e) || 1));
    let upgradeTriggerMax = baseMax;
    if (effectiveLevel > baseLevel) {
        let nextLevel = Math.max(1, baseLevel + 1);
        upgradeTriggerMax = Math.max(1, Math.floor(getUpgrademaxEnergy(e, nextLevel) || baseMax));
    }
    let effectiveMax = Math.max(1, Math.floor(getEntityEffectiveEnergyMax(e) || upgradeTriggerMax));
    let currentEnergy = Number(e.energy);
    if (!Number.isFinite(currentEnergy)) currentEnergy = effectiveMax;
    currentEnergy = Math.max(0, currentEnergy);
    return { currentEnergy, upgradeTriggerMax, effectiveMax };
}

function formatThingEnergyDisplay(e) {
    let energyView = getThingEnergyDisplayValues(e);
    let current = Math.floor(energyView.currentEnergy);
    return {
        base: formatInfoFraction(current, energyView.upgradeTriggerMax),
        effective: formatInfoFraction(current, energyView.effectiveMax)
    };
}

function formatThingGroupEnergyDisplay(group) {
    let totalEnergy = 0;
    let totalUpgradeTriggerMax = 0;
    let totalEffectiveMax = 0;
    for (let e of (group || [])) {
        let energyView = getThingEnergyDisplayValues(e);
        totalEnergy += energyView.currentEnergy;
        totalUpgradeTriggerMax += energyView.upgradeTriggerMax;
        totalEffectiveMax += energyView.effectiveMax;
    }
    let totalCurrent = Math.floor(totalEnergy);
    return {
        base: formatInfoFraction(totalCurrent, Math.max(1, Math.floor(totalUpgradeTriggerMax || 1))),
        effective: formatInfoFraction(totalCurrent, Math.max(1, Math.floor(totalEffectiveMax || 1)))
    };
}

function getEntityStatusText(e, includeResearch = false) {
    if (!e) return '';
    if (e.underConstruction) return '\uD83D\uDD28 Building';
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

function formatStacksValueText(stacks, allowZero = false) {
    let minValue = allowZero ? 0 : 1;
    let fallback = allowZero ? 0 : 1;
    let value = Math.max(minValue, Number(stacks) || fallback);
    return value.toFixed(1);
}

function infoRowStacks(baseStacks, baseLevel, effStacks, effLevel, manualStacks = baseStacks) {
    let stacked = Math.max(1, Number(baseStacks) || 1);
    let manual = Math.max(stacked, Number(manualStacks) || stacked);
    let remaining = getThingRemainingStacks({ stacks: stacked, manualStacks: manual });
    if (!Number.isFinite(remaining)) remaining = Math.max(0, manual - stacked);
    remaining = Math.max(0, remaining);
    let remainingText = remaining > 0
        ? ` <span style="color:#7f7">+</span> <span style="color:#49c0ff">${formatStacksValueText(remaining, true)}</span>`
        : '';
    let baseText = `<span style="display:inline-block;min-width:72px;white-space:nowrap">${formatStacksValueText(stacked)}${remainingText}</span>`;
    let hasEff = Number.isFinite(effStacks) && Number.isFinite(effLevel);
    let matrixOpts = {
        title: 'Stacks',
        getValue: (thingLevel) => `x${getRequiredStacksForLevel(Math.max(1, Math.floor(Number(thingLevel) || 1)))}`
    };
    if (!hasEff) return infoRow('Stacks', baseText, undefined, matrixOpts);
    let effText = `<span style="display:inline-block;min-width:52px;white-space:nowrap">${formatStacksValueText(effStacks)}</span>`;
    return infoRow('Stacks', baseText, effText, matrixOpts);
}

function renderBarrackInfo(e) {
    let html = '';
    let bKey = 'barrack_' + e.unitType;
    let baseLvl = e.level || stackCountToLevel(e.stacks || 1);
    let effLvl = getThingEffectiveLevel(e, baseLvl);
    let uEnergy = getUnitStatForOwner(e.owner, e.unitType, effLvl, 'energy');
    let uAtk = getUnitStatForOwner(e.owner, e.unitType, effLvl, 'atk');
    let uRange = getUnitStatForOwner(e.owner, e.unitType, effLvl, 'attackRange');
    let uSpeed = getUnitStatForOwner(e.owner, e.unitType, effLvl, 'speed');
    let baseBuildingUpKeep = getBuildingStatForOwner(e.owner, e.type, baseLvl, 'upKeep');
    let effBuildingUpKeep = getBuildingStatForOwner(e.owner, e.type, effLvl, 'upKeep');
    let baseUnitUpKeep = getUnitStatForOwner(e.owner, e.unitType, baseLvl, 'upKeep');
    let effUnitUpKeep = getUnitStatForOwner(e.owner, e.unitType, effLvl, 'upKeep');
    let upg = getNextLevelUpgradeInfo(e);
    let baseVisTiles = getEntityBaseVisibilityRangeTiles(e);
    let effVisTiles = getEntityEffectiveVisibilityRangeTiles(e);
    let energyDisplay = formatThingEnergyDisplay(e);
    html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRow(_buildInfoPanelEntityStateLabel(e), _getInfoPanelEntityStateLabel(e));
    html += infoRow(_buildInfoPanelAssignedLabelButton('entity', { gx: e.gx, gy: e.gy, targetType: e.type || '' }), _buildInfoPanelAssignedWorkersHtml(e));
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    html += infoRow('Visibility', formatRangeStatTiles(baseVisTiles), formatRangeStatTiles(effVisTiles));
    if (Number.isFinite(baseBuildingUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(baseBuildingUpKeep, 2)}⚡/ s`, Number.isFinite(effBuildingUpKeep) ? `${formatBigNumber(effBuildingUpKeep, 2)}⚡/ s` : `${formatBigNumber(baseBuildingUpKeep, 2)}⚡/ s`);
    }
    // // html += infoRow('Upgrade', `${upg.goldCost}g, ENERGY ${upg.energyNow}->${upg.energyNext}`);
    html += infoRow('Unit Energy', Number.isFinite(uEnergy) ? Math.floor(uEnergy) : '?');
    if (Number.isFinite(baseUnitUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton('Unit UpKeep', { title: `${e.unitType} / UpKeep`, kind: 'unit', key: e.unitType, statKey: 'upKeep' }), `${formatBigNumber(baseUnitUpKeep, 2)}⚡/ s`);
    }
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
    let totalBaseVis = 0;
    let totalEffVis = 0;
    let totalBaseUpKeep = 0;
    let totalEffUpKeep = 0;
    let totalBaseUnitUpKeep = 0;
    let totalEffUnitUpKeep = 0;
    let readyGroup = group.filter(b => !b.underConstruction);
    let totalQueue = 0;
    for (let b of group) {
        let bBaseLevel = b.level || stackCountToLevel(b.stacks || 1);
        let bEffLevel = getThingEffectiveLevel(b, bBaseLevel);
        totalBaseUpKeep += Number(getBuildingStatForOwner(b.owner, b.type, bBaseLevel, 'upKeep')) || 0;
        totalEffUpKeep += Number(getBuildingStatForOwner(b.owner, b.type, bEffLevel, 'upKeep')) || 0;
        totalBaseUnitUpKeep += Number(getUnitStatForOwner(b.owner, b.unitType, bBaseLevel, 'upKeep')) || 0;
        totalEffUnitUpKeep += Number(getUnitStatForOwner(b.owner, b.unitType, bEffLevel, 'upKeep')) || 0;
        totalBaseVis += Number(getEntityBaseVisibilityRangeTiles(b)) || 0;
        totalEffVis += Number(getEntityEffectiveVisibilityRangeTiles(b)) || 0;
    }
    for (let b of readyGroup) totalQueue += b.spawnQueue.length;
    let energyDisplay = formatThingGroupEnergyDisplay(group);
    html += infoRow('Count', group.length);
    html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    let avgBaseVis = group.length > 0 ? totalBaseVis / group.length : 0;
    let avgEffVis = group.length > 0 ? totalEffVis / group.length : 0;
    html += infoRow('Visibility', `${formatRangeStatTiles(avgBaseVis)} avg`, `${formatRangeStatTiles(avgEffVis)} avg`);
    html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(totalBaseUpKeep, 2)}⚡/ s`, `${formatBigNumber(totalEffUpKeep, 2)}⚡/ s`);
    html += infoRow('Unit Energy', Number.isFinite(uEnergy) ? Math.floor(uEnergy) : '?');
    html += infoRow(withInfoPanelStatMatrixButton('Unit UpKeep', { title: `${e.unitType} / UpKeep`, kind: 'unit', key: e.unitType, statKey: 'upKeep' }), `${formatBigNumber(totalBaseUnitUpKeep, 2)}⚡/ s`);
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
    let baseUpKeep = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'upKeep');
    let effUpKeep = getBuildingStatForOwner(e.owner, e.type, effLevel, 'upKeep');
    if (!Number.isFinite(baseVis)) baseVis = 0;
    if (!Number.isFinite(effVis)) effVis = baseVis;
    let energyDisplay = formatThingEnergyDisplay(e);
    html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRow(_buildInfoPanelEntityStateLabel(e), _getInfoPanelEntityStateLabel(e));
    html += infoRow(_buildInfoPanelAssignedLabelButton('entity', { gx: e.gx, gy: e.gy, targetType: e.type || '' }), _buildInfoPanelAssignedWorkersHtml(e));
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    if (Number.isFinite(baseUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(baseUpKeep, 2)}⚡/ s`, Number.isFinite(effUpKeep) ? `${formatBigNumber(effUpKeep, 2)}⚡/ s` : `${formatBigNumber(baseUpKeep, 2)}⚡/ s`);
    }
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
    let energyDisplay = formatThingGroupEnergyDisplay(group);
    let s = e.currentStats || e.baseStats;
    let bs = e.baseStats;
    let baseLevel = stackCountToLevel(e.stacks || 1);
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    let dps = s.cd > 0 ? (s.damage / s.cd).toFixed(1) : '0';
    let baseDps = bs && bs.cd > 0 ? (bs.damage / bs.cd).toFixed(1) : '0';
    let baseVis = Number(getEntityBaseVisibilityRangeTiles(e));
    let effVis = Number(getEntityEffectiveVisibilityRangeTiles(e));
    let totalBaseUpKeep = 0;
    let totalEffUpKeep = 0;
    for (let t of group) {
        let tBaseLevel = t.level || stackCountToLevel(t.stacks || 1);
        let tEffLevel = getThingEffectiveLevel(t, tBaseLevel);
        totalBaseUpKeep += Number(getBuildingStatForOwner(t.owner, t.type, tBaseLevel, 'upKeep')) || 0;
        totalEffUpKeep += Number(getBuildingStatForOwner(t.owner, t.type, tEffLevel, 'upKeep')) || 0;
    }
    if (!Number.isFinite(baseVis)) baseVis = 0;
    if (!Number.isFinite(effVis)) effVis = baseVis;
    html += infoRow('Count', group.length);
    html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(totalBaseUpKeep, 2)}⚡/ s`, `${formatBigNumber(totalEffUpKeep, 2)}⚡/ s`);
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
    let workerUnitType = e.type === 'spawner' ? 'collector'
        : e.type === 'astar_spawner' ? 'astar_collector'
        : e.type === 'builder_spawner' ? 'builder_unit'
        : e.type === 'healer_spawner' ? 'healer_unit'
        : 'salvager_unit';
    let baseStacks = e.stacks || 1;
    let sLevel = stackCountToLevel(baseStacks);
    let effStacks = e.effectiveStacks || baseStacks;
    let effLevel = getThingEffectiveLevel(e, sLevel);
    let upg = getNextLevelUpgradeInfo(e);
    let baseVisTiles = getEntityBaseVisibilityRangeTiles(e);
    let effVisTiles = getEntityEffectiveVisibilityRangeTiles(e);
    let baseUpKeep = getBuildingStatForOwner(e.owner, e.type, sLevel, 'upKeep');
    let effUpKeep = getBuildingStatForOwner(e.owner, e.type, effLevel, 'upKeep');
    let baseWorkerUpKeep = getUnitStatForOwner(e.owner, workerUnitType, sLevel, 'upKeep');
    let effWorkerUpKeep = getUnitStatForOwner(e.owner, workerUnitType, effLevel, 'upKeep');
    let energyDisplay = formatThingEnergyDisplay(e);
    html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRow(_buildInfoPanelEntityStateLabel(e), _getInfoPanelEntityStateLabel(e));
    html += infoRow(_buildInfoPanelAssignedLabelButton('entity', { gx: e.gx, gy: e.gy, targetType: e.type || '' }), _buildInfoPanelAssignedWorkersHtml(e));
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(baseStacks, sLevel, effStacks, effLevel, getThingManualStacks(e));
    html += infoRow('Visibility', formatRangeStatTiles(baseVisTiles), formatRangeStatTiles(effVisTiles));
    if (Number.isFinite(baseUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(baseUpKeep, 2)}⚡/ s`, Number.isFinite(effUpKeep) ? `${formatBigNumber(effUpKeep, 2)}⚡/ s` : `${formatBigNumber(baseUpKeep, 2)}⚡/ s`);
    }
    if (Number.isFinite(baseWorkerUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton(`${unitLabel} UpKeep`, { title: `${workerUnitType} / UpKeep`, kind: 'unit', key: workerUnitType, statKey: 'upKeep' }), `${formatBigNumber(baseWorkerUpKeep, 2)}⚡/ s`);
    }
    let baseWorkerSearchDistance = getUnitStatForOwner(e.owner, workerUnitType, sLevel, 'workerSearchDistance');
    let effWorkerSearchDistance = getUnitStatForOwner(e.owner, workerUnitType, effLevel, 'workerSearchDistance');
    if (Number.isFinite(baseWorkerSearchDistance)) {
        html += infoRow(withInfoPanelStatMatrixButton('Work Distance', { title: `${e.type} / Work Distance`, kind: 'unit', key: workerUnitType, statKey: 'workerSearchDistance' }), formatAreaDistanceStat(baseWorkerSearchDistance), Number.isFinite(effWorkerSearchDistance) ? formatAreaDistanceStat(effWorkerSearchDistance) : formatAreaDistanceStat(baseWorkerSearchDistance));
    }
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
    let baseUpKeep = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'upKeep');
    let effUpKeep = getBuildingStatForOwner(e.owner, e.type, effLevel, 'upKeep');
    let energyDisplay = formatThingEnergyDisplay(e);
    if (baseStats.maxEnergy > 0) html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRow(_buildInfoPanelEntityStateLabel(e), _getInfoPanelEntityStateLabel(e));
    html += infoRow(_buildInfoPanelAssignedLabelButton('entity', { gx: e.gx, gy: e.gy, targetType: e.type || '' }), _buildInfoPanelAssignedWorkersHtml(e));
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(baseStacks, baseLevel, effStacks, effLevel, getThingManualStacks(e));
    html += infoRow('Visibility', formatRangeStatTiles(baseVisTiles), formatRangeStatTiles(effVisTiles));
    if (Number.isFinite(baseUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(baseUpKeep, 2)}\u26A1/ s`, Number.isFinite(effUpKeep) ? `${formatBigNumber(effUpKeep, 2)}\u26A1/ s` : `${formatBigNumber(baseUpKeep, 2)}\u26A1/ s`);
    }
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
        let buildingKey = e.type === 'astar_farm' ? 'astar_farm' : 'farm';
        let baseInc = getBuildingStatForOwner(e.owner, buildingKey, baseLevel, 'multiplier');
        let effInc = getBuildingStatForOwner(e.owner, buildingKey, effLevel, 'multiplier');
        if (!Number.isFinite(baseInc)) baseInc = Math.max(1, baseLevel);
        if (!Number.isFinite(effInc)) effInc = Math.max(1, effLevel);
        let gatherLabel = 'x Work Speed';
        html += infoRow(withInfoPanelStatMatrixButton('Multiplier', { title: `${buildingKey} / Multiplier`, kind: 'building', key: buildingKey, statKey: 'multiplier' }), `${baseInc.toFixed(2)}${gatherLabel}`, Math.abs(baseInc - effInc) > 1e-6 ? `${effInc.toFixed(2)}${gatherLabel}` : undefined);
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
    let baseStats = u.basePreComputed || u.preComputed || {};
    let effStats = u.preComputed || baseStats;
    let basemaxEnergy = Math.max(1, Math.floor(Number(baseStats.maxEnergy) || 1));
    let effmaxEnergy = Math.max(1, Math.floor(Number(effStats.maxEnergy) || basemaxEnergy));
    let energyRatio = effmaxEnergy > 0 ? (u.energy / effmaxEnergy) : 1;
    let baseEnergyNow = Math.max(1, Math.floor(basemaxEnergy * energyRatio));

    let baseAtk = Math.max(0, Number(baseStats.attackDamage) || 0);
    let baseCd = Math.max(1, Number(baseStats.attackCooldown) || 1);
    let effAtk = Math.max(0, Number(effStats.attackDamage) || 0);
    let effCd = Math.max(1, Number(effStats.attackCooldown) || 1);
    let baseDps = baseCd > 0 ? (baseAtk / baseCd * TICK_RATE).toFixed(1) : '0';
    let effDps = effCd > 0 ? (effAtk / effCd * TICK_RATE).toFixed(1) : '0';

    let slowMul = 1;
    if (u.frozen > 0) slowMul *= 0.5;
    if (u.sandy > 0) slowMul *= 0.5;
    let baseSpd = (Number(baseStats.speed) || 0) * slowMul;
    let effSpd = (Number(effStats.speed) || 0) * slowMul;
    let baseAttackRange = Math.max(0, (Number(baseStats.attackRange) || 0) / TILE);
    let effAttackRange = Math.max(0, (Number(effStats.attackRange) || 0) / TILE);
    let baseVisionRange = Math.max(0, Number(baseStats.visionRangeArea) || ((Number(baseStats.visionRange) || 0) / AREA_UNIT_TILE_EQUIVALENT));
    let effVisionRange = Math.max(0, Number(effStats.visionRangeArea) || ((Number(effStats.visionRange) || 0) / AREA_UNIT_TILE_EQUIVALENT));
    let baseUpKeep = getUnitStatForOwner(u.owner, u.unitType, lvl, 'upKeep');
    let effUpKeep = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'upKeep');

    html += infoRow(withInfoPanelStatMatrixButton('Energy', { title: `${u.unitType} / Energy`, kind: 'unit', key: u.unitType, statKey: 'energy' }), formatInfoFraction(baseEnergyNow, basemaxEnergy));
    html += infoRow('Level', `L${lvl}`, `L${effLvl}`);
    html += infoRowStacks(stacks, lvl, effStacks, effLvl, stacks);
    if (Number.isFinite(baseUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${u.unitType} / UpKeep`, kind: 'unit', key: u.unitType, statKey: 'upKeep' }), `${formatBigNumber(baseUpKeep, 2)}\u26A1/ s`);
    }
    html += infoRow(withInfoPanelStatMatrixButton('Range', { title: `${u.unitType} / Range`, kind: 'unit', key: u.unitType, statKey: 'attackRange' }), formatRangeStatTiles(baseAttackRange), formatRangeStatTiles(effAttackRange));
    html += infoRow(withInfoPanelStatMatrixButton('Visibility', { title: `${u.unitType} / Visibility`, kind: 'unit', key: u.unitType, statKey: 'visionRange' }), formatAreaDistanceStat(baseVisionRange), formatAreaDistanceStat(effVisionRange));
    if (u.workerType === 'builder') {
        let baseBuild = Number(baseStats.builderDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'builderDps') || 0;
        let effBuild = Number(effStats.builderDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'builderDps') || 0;
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        let baseWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance');
        let effWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'workerSearchDistance');
        html += infoRow(withInfoPanelStatMatrixButton('Work Speed', { title: `${u.unitType} / Work Speed`, kind: 'unit', key: u.unitType, statKey: 'builderDps' }), `${formatBigNumber(baseBuild, 1)}\u26A1`, `${formatBigNumber(effBuild, 1)}\u26A1`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
        if (Number.isFinite(baseWorkerSearchDistance)) html += infoRow(withInfoPanelStatMatrixButton('Work Distance', { title: `${u.unitType} / Work Distance`, kind: 'unit', key: u.unitType, statKey: 'workerSearchDistance' }), formatAreaDistanceStat(baseWorkerSearchDistance), Number.isFinite(effWorkerSearchDistance) ? formatAreaDistanceStat(effWorkerSearchDistance) : formatAreaDistanceStat(baseWorkerSearchDistance));
    } else if (u.workerType === 'healer') {
        let baseHeal = Number(baseStats.healerDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'healerDps') || 0;
        let effHeal = Number(effStats.healerDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'healerDps') || 0;
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        let baseWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance');
        let effWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'workerSearchDistance');
        html += infoRow(withInfoPanelStatMatrixButton('Work Speed', { title: `${u.unitType} / Work Speed`, kind: 'unit', key: u.unitType, statKey: 'healerDps' }), `${formatBigNumber(baseHeal, 1)}\u26A1`, `${formatBigNumber(effHeal, 1)}\u26A1`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
        if (Number.isFinite(baseWorkerSearchDistance)) html += infoRow(withInfoPanelStatMatrixButton('Work Distance', { title: `${u.unitType} / Work Distance`, kind: 'unit', key: u.unitType, statKey: 'workerSearchDistance' }), formatAreaDistanceStat(baseWorkerSearchDistance), Number.isFinite(effWorkerSearchDistance) ? formatAreaDistanceStat(effWorkerSearchDistance) : formatAreaDistanceStat(baseWorkerSearchDistance));
    } else if (u.workerType === 'researcher') {
        let baseResearch = Number(baseStats.researcherDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'researcherDps') || 0;
        let effResearch = Number(effStats.researcherDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'researcherDps') || 0;
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        let baseWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance');
        let effWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'workerSearchDistance');
        html += infoRow(withInfoPanelStatMatrixButton('Work Speed', { title: `${u.unitType} / Work Speed`, kind: 'unit', key: u.unitType, statKey: 'researcherDps' }), `${formatBigNumber(baseResearch, 1)}\u26A1`, `${formatBigNumber(effResearch, 1)}\u26A1`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
        if (Number.isFinite(baseWorkerSearchDistance)) html += infoRow(withInfoPanelStatMatrixButton('Work Distance', { title: `${u.unitType} / Work Distance`, kind: 'unit', key: u.unitType, statKey: 'workerSearchDistance' }), formatAreaDistanceStat(baseWorkerSearchDistance), Number.isFinite(effWorkerSearchDistance) ? formatAreaDistanceStat(effWorkerSearchDistance) : formatAreaDistanceStat(baseWorkerSearchDistance));
    } else if (u.workerType === 'collector' || u.workerType === 'astar_collector') {
        let baseGather = Number(baseStats.gatherPerTrip) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'gatherPerTrip') || 0;
        let effGather = Number(effStats.gatherPerTrip) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'gatherPerTrip') || 0;
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        let baseWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance');
        let effWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'workerSearchDistance');
        html += infoRow(withInfoPanelStatMatrixButton('Work Speed', { title: `${u.unitType} / Work Speed`, kind: 'unit', key: u.unitType, statKey: 'gatherPerTrip' }), `${formatBigNumber(baseGather, 1)}\u26A1`, `${formatBigNumber(effGather, 1)}\u26A1`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
        if (Number.isFinite(baseWorkerSearchDistance)) html += infoRow(withInfoPanelStatMatrixButton('Work Distance', { title: `${u.unitType} / Work Distance`, kind: 'unit', key: u.unitType, statKey: 'workerSearchDistance' }), formatAreaDistanceStat(baseWorkerSearchDistance), Number.isFinite(effWorkerSearchDistance) ? formatAreaDistanceStat(effWorkerSearchDistance) : formatAreaDistanceStat(baseWorkerSearchDistance));
    } else if (u.workerType === 'salvager') {
        let baseTransferCd = getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown');
        let effTransferCd = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown');
        let baseWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, lvl, 'workerSearchDistance');
        let effWorkerSearchDistance = getUnitStatForOwner(u.owner, u.unitType, effLvl, 'workerSearchDistance');
        html += infoRow('Salvage Yield', `10% x L${lvl}`, `10% x L${effLvl}`);
        if (Number.isFinite(baseTransferCd)) html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u.unitType} / Transfer CD`, kind: 'unit', key: u.unitType, statKey: 'transferCooldown' }), `${baseTransferCd.toFixed(2)}s`, Number.isFinite(effTransferCd) ? `${effTransferCd.toFixed(2)}s` : `${baseTransferCd.toFixed(2)}s`);
        if (Number.isFinite(baseWorkerSearchDistance)) html += infoRow(withInfoPanelStatMatrixButton('Work Distance', { title: `${u.unitType} / Work Distance`, kind: 'unit', key: u.unitType, statKey: 'workerSearchDistance' }), formatAreaDistanceStat(baseWorkerSearchDistance), Number.isFinite(effWorkerSearchDistance) ? formatAreaDistanceStat(effWorkerSearchDistance) : formatAreaDistanceStat(baseWorkerSearchDistance));
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
    html += infoRow(withInfoPanelStatMatrixButton('★ / Tile', { title: `${u.unitType} / A* Cost`, kind: 'unit', key: u.unitType, statKey: 'astarCost' }), formatBigNumber(baseAstarCost, 2), formatBigNumber(effAstarCost, 2));
    html += infoRow(_buildInfoPanelUnitStateLabel(u), _getInfoPanelUnitStateLabel(u));
    if (u.workerType) html += infoRow(_buildInfoPanelAssignedLabelButton('worker', { unitId: u.id }), _buildInfoPanelWorkerAssignedTargetHtml(u));
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
    let totalBaseUpKeep = 0, totalEffUpKeep = 0;
    let totalBaseNextStacks = 0, totalEffNextStacks = 0;
    let baseLevels = new Set(), effLevels = new Set();

    for (let u of group) {
        let lvl = getUnitBaseLevel(u);
        let effLvl = getUnitEffectiveLevel(u, lvl);
        let stacks = getUnitStackCount(u);
        let effStacks = Math.max(1, Math.floor(u.effectiveStacks || stacks));
        let baseStats = u.basePreComputed || u.preComputed || {};
        let effStats = u.preComputed || baseStats;
        let effmaxEnergy = Math.max(1, Math.floor(Number(effStats.maxEnergy) || 1));
        let ratio = effmaxEnergy > 0 ? (u.energy / effmaxEnergy) : 1;
        let basemaxEnergy = Math.max(1, Math.floor(Number(baseStats.maxEnergy) || effmaxEnergy));
        let baseCurEnergy = Math.max(1, Math.floor(basemaxEnergy * ratio));

        let baseAtk = Math.max(0, Number(baseStats.attackDamage) || 0);
        let baseCd = Math.max(1, Number(baseStats.attackCooldown) || 1);
        let effAtk = Math.max(0, Number(effStats.attackDamage) || 0);
        let effCd = Math.max(1, Number(effStats.attackCooldown) || 1);

        let slowMul = 1;
        if (u.frozen > 0) slowMul *= 0.5;
        if (u.sandy > 0) slowMul *= 0.5;

        totalEnergy += u.energy;
        totalmaxEnergy += effmaxEnergy;
        totalbaseEnergy += baseCurEnergy;
        totalBasemaxEnergy += basemaxEnergy;
        totalStacks += stacks;
        totalEffStacks += effStacks;
        totalBaseAttack += baseAtk;
        totalEffAttack += effAtk;
        totalBaseDps += baseCd > 0 ? (baseAtk / baseCd * TICK_RATE) : 0;
        totalEffDps += effCd > 0 ? (effAtk / effCd * TICK_RATE) : 0;
        totalBaseSpeed += (Number(baseStats.speed) || 0) * slowMul;
        totalEffSpeed += (Number(effStats.speed) || 0) * slowMul;
        totalBaseRange += Math.max(0, (Number(baseStats.attackRange) || 0) / TILE);
        totalEffRange += Math.max(0, (Number(effStats.attackRange) || 0) / TILE);
        totalBaseVision += Math.max(0, Number(baseStats.visionRange) || 0);
        totalEffVision += Math.max(0, Number(effStats.visionRange) || 0);
        totalBaseUpKeep += Number(getUnitStatForOwner(u.owner, u.unitType, lvl, 'upKeep')) || 0;
        totalEffUpKeep += Number(getUnitStatForOwner(u.owner, u.unitType, effLvl, 'upKeep')) || 0;
        totalBaseNextStacks += getRequiredStacksForLevel(lvl + 1);
        totalEffNextStacks += getRequiredStacksForLevel(effLvl + 1);
        baseLevels.add(lvl);
        effLevels.add(effLvl);

        if (u.workerType === 'builder') {
            totalBuildSpeed += (Number(baseStats.builderDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'builderDps') || 0);
            totalEffBuildSpeed += (Number(effStats.builderDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'builderDps') || 0);
            totalTransferCd += (getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown') || 0);
            totalEffTransferCd += (getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown') || 0);
        } else if (u.workerType === 'healer') {
            totalHealSpeed += (Number(baseStats.healerDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'healerDps') || 0);
            totalEffHealSpeed += (Number(effStats.healerDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'healerDps') || 0);
            totalTransferCd += (getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown') || 0);
            totalEffTransferCd += (getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown') || 0);
        } else if (u.workerType === 'researcher') {
            totalBuildSpeed += (Number(baseStats.researcherDps) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'researcherDps') || 0);
            totalEffBuildSpeed += (Number(effStats.researcherDps) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'researcherDps') || 0);
            totalTransferCd += (getUnitStatForOwner(u.owner, u.unitType, lvl, 'transferCooldown') || 0);
            totalEffTransferCd += (getUnitStatForOwner(u.owner, u.unitType, effLvl, 'transferCooldown') || 0);
        } else if (u.workerType === 'collector' || u.workerType === 'astar_collector') {
            totalCollectorPerTrip += (Number(baseStats.gatherPerTrip) || getUnitStatForOwner(u.owner, u.unitType, lvl, 'gatherPerTrip') || 0);
            totalEffCollectorPerTrip += (Number(effStats.gatherPerTrip) || getUnitStatForOwner(u.owner, u.unitType, effLvl, 'gatherPerTrip') || 0);
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
    html += infoRow('Energy', formatInfoFraction(Math.floor(totalbaseEnergy), totalBasemaxEnergy));
    html += infoRow('Level', levelSummary, effLevelSummary);
    html += infoRow('Stacks', formatStacksValueText(totalStacks), formatStacksValueText(totalEffStacks));
    html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${u0.unitType} / UpKeep`, kind: 'unit', key: u0.unitType, statKey: 'upKeep' }), `${formatBigNumber(totalBaseUpKeep, 2)}\u26A1/ s`);
    let avgBaseRange = totalBaseRange / Math.max(1, group.length);
    let avgEffRange = totalEffRange / Math.max(1, group.length);
    let avgBaseVision = totalBaseVision / Math.max(1, group.length);
    let avgEffVision = totalEffVision / Math.max(1, group.length);
    html += infoRow(withInfoPanelStatMatrixButton('Range', { title: `${u0.unitType} / Range`, kind: 'unit', key: u0.unitType, statKey: 'attackRange' }), `${formatRangeStatTiles(avgBaseRange)} avg`, `${formatRangeStatTiles(avgEffRange)} avg`);
    html += infoRow(withInfoPanelStatMatrixButton('Visibility', { title: `${u0.unitType} / Visibility`, kind: 'unit', key: u0.unitType, statKey: 'visionRange' }), `${formatRangeStatTiles(avgBaseVision)} avg`, `${formatRangeStatTiles(avgEffVision)} avg`);
    if (u0.workerType === 'builder') {
        html += infoRow(withInfoPanelStatMatrixButton('Work Speed', { title: `${u0.unitType} / Work Speed`, kind: 'unit', key: u0.unitType, statKey: 'builderDps' }), `${formatBigNumber(totalBuildSpeed, 1)}\u26A1`, `${formatBigNumber(totalEffBuildSpeed, 1)}\u26A1`);
        html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u0.unitType} / Transfer CD`, kind: 'unit', key: u0.unitType, statKey: 'transferCooldown' }), `${(totalTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`, `${(totalEffTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`);
    } else if (u0.workerType === 'healer') {
        html += infoRow(withInfoPanelStatMatrixButton('Work Speed', { title: `${u0.unitType} / Work Speed`, kind: 'unit', key: u0.unitType, statKey: 'healerDps' }), `${formatBigNumber(totalHealSpeed, 1)}\u26A1`, `${formatBigNumber(totalEffHealSpeed, 1)}\u26A1`);
        html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u0.unitType} / Transfer CD`, kind: 'unit', key: u0.unitType, statKey: 'transferCooldown' }), `${(totalTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`, `${(totalEffTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`);
    } else if (u0.workerType === 'researcher') {
        html += infoRow(withInfoPanelStatMatrixButton('Work Speed', { title: `${u0.unitType} / Work Speed`, kind: 'unit', key: u0.unitType, statKey: 'researcherDps' }), `${formatBigNumber(totalBuildSpeed, 1)}\u26A1`, `${formatBigNumber(totalEffBuildSpeed, 1)}\u26A1`);
        html += infoRow(withInfoPanelStatMatrixButton('Transfer CD', { title: `${u0.unitType} / Transfer CD`, kind: 'unit', key: u0.unitType, statKey: 'transferCooldown' }), `${(totalTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`, `${(totalEffTransferCd / Math.max(1, group.length)).toFixed(2)}s avg`);
    } else if (u0.workerType === 'collector' || u0.workerType === 'astar_collector') {
        html += infoRow(withInfoPanelStatMatrixButton('Work Speed', { title: `${u0.unitType} / Work Speed`, kind: 'unit', key: u0.unitType, statKey: 'gatherPerTrip' }), `${formatBigNumber(totalCollectorPerTrip, 1)}\u26A1`, `${formatBigNumber(totalEffCollectorPerTrip, 1)}\u26A1`);
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
    if (_isGoldMineLikeEntity(e)) return renderGoldMineInfo(e);
    if (_isAstarMineLikeEntity(e)) return renderAstarMineInfo(e);
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
    if (_isGoldMineLikeEntity(e)) return renderGoldMineGroupInfo(group);
    if (_isAstarMineLikeEntity(e)) return renderAstarMineGroupInfo(group);
    if (e.type === 'research') return runWithInfoPanelStatMatrixContext(ctx, () => renderResearchGroupInfo(group));
    if (e.type === 'spawner' || e.type === 'astar_spawner' || e.type === 'salvager' || e.type === 'builder_spawner' || e.type === 'healer_spawner') return runWithInfoPanelStatMatrixContext(ctx, () => renderSpawnerGroupInfo(group));
    if (e.type && BASE_CARD_TYPES[e.type]) return runWithInfoPanelStatMatrixContext(ctx, () => renderFloorItemGroupInfo(group));
    return '';
}

function shouldRenderMixedEntitySubgroupAsGroup(group) {
    let e = Array.isArray(group) ? group[0] : group;
    if (!e) return false;
    if (e.type === 'barrack' && e.unitType) return true;
    return e.type === 'spawner'
        || e.type === 'astar_spawner'
        || e.type === 'salvager'
        || e.type === 'builder_spawner'
        || e.type === 'healer_spawner';
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
    let workerUnitType = e.type === 'spawner' ? 'collector'
        : e.type === 'astar_spawner' ? 'astar_collector'
        : e.type === 'builder_spawner' ? 'builder_unit'
        : e.type === 'healer_spawner' ? 'healer_unit'
        : 'salvager_unit';
    let baseStacks = e.stacks || 1;
    let sLevel = stackCountToLevel(baseStacks);
    let effStacks = e.effectiveStacks || baseStacks;
    let effLevel = getThingEffectiveLevel(e, sLevel);
    let totalBaseVis = 0;
    let totalEffVis = 0;
    let totalBaseUpKeep = 0;
    let totalEffUpKeep = 0;
    let totalBaseWorkerUpKeep = 0;
    let totalEffWorkerUpKeep = 0;
    let readyGroup = group.filter(s => !s.underConstruction);
    let totalQueue = 0;
    for (let s of group) {
        let sBaseLevel = s.level || stackCountToLevel(s.stacks || 1);
        let sEffLevel = getThingEffectiveLevel(s, sBaseLevel);
        totalBaseUpKeep += Number(getBuildingStatForOwner(s.owner, s.type, sBaseLevel, 'upKeep')) || 0;
        totalEffUpKeep += Number(getBuildingStatForOwner(s.owner, s.type, sEffLevel, 'upKeep')) || 0;
        totalBaseWorkerUpKeep += Number(getUnitStatForOwner(s.owner, workerUnitType, sBaseLevel, 'upKeep')) || 0;
        totalEffWorkerUpKeep += Number(getUnitStatForOwner(s.owner, workerUnitType, sEffLevel, 'upKeep')) || 0;
        totalBaseVis += Number(getEntityBaseVisibilityRangeTiles(s)) || 0;
        totalEffVis += Number(getEntityEffectiveVisibilityRangeTiles(s)) || 0;
    }
    for (let s of readyGroup) totalQueue += (s.spawnQueue || []).length;
    let energyDisplay = formatThingGroupEnergyDisplay(group);
    html += infoRow('Count', group.length);
    html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(baseStacks, sLevel, effStacks, effLevel, getThingManualStacks(e));
    let avgBaseVis = group.length > 0 ? totalBaseVis / group.length : 0;
    let avgEffVis = group.length > 0 ? totalEffVis / group.length : 0;
    html += infoRow('Visibility', `${formatRangeStatTiles(avgBaseVis)} avg`, `${formatRangeStatTiles(avgEffVis)} avg`);
    html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(totalBaseUpKeep, 2)}\u26A1/ s`, `${formatBigNumber(totalEffUpKeep, 2)}\u26A1/ s`);
    html += infoRow(withInfoPanelStatMatrixButton(`${unitLabel} UpKeep`, { title: `${workerUnitType} / UpKeep`, kind: 'unit', key: workerUnitType, statKey: 'upKeep' }), `${formatBigNumber(totalBaseWorkerUpKeep, 2)}\u26A1/ s`);
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
    if (kind === 'building' && statKey === 'maxLevel') {
        return Math.max(1, Math.min(MAX_THING_LEVEL, 1 + Math.round(rLvl * (MAX_THING_LEVEL - 1) / Math.max(1, MAX_RESEARCH_LEVEL))));
    }
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

function _renderResearchQueueThingIconHtml(thing, size = 20) {
    if (!thing || !thing.key) return '';
    let s = Math.max(12, Math.floor(Number(size) || 20));
    let radius = thing.kind === 'unit' ? '50%' : '4px';
    return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${s}px;height:${s}px;border:1px solid #2b2b2b;border-radius:${radius};background:#111;overflow:hidden;flex:0 0 auto"><img src="${getItemThumbnail(thing.key, s)}" width="${s}" height="${s}" style="display:block;${thing.kind === 'unit' ? 'border-radius:50%;' : ''}"></span>`;
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
        let statLabel = stat ? stat.label : (t.statKey || 'stat');
        let thingVisual = _renderResearchQueueThingIconHtml(thing, 18);
        let thingTextFallback = thing ? '' : `${t.kind}:${t.key} / `;
        let canAfford = !preview.atMax;
        let selectedThingLevel = getResearchPreviewThingLevel();
        let baseValue = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, 0, selectedThingLevel);
        let projectedMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(preview.toValue))
            ? (preview.toValue / baseValue)
            : NaN;
        let queueItemValueLabel = t.statKey === 'maxLevel'
            ? formatResearchStatValue('maxLevel', preview.toValue)
            : `x${formatResearchMultiplierValue(projectedMultiplier)}`;

        let pendingIndex = t.isActiveTask ? -1 : (i - ((orderedTasks[0] && orderedTasks[0].isActiveTask) ? 1 : 0));

        html += `<div class="info-research-queue-item" data-owner="${e.owner}" data-gx="${e.gx}" data-gy="${e.gy}" data-active="${t.isActiveTask ? '1' : '0'}" data-pending-index="${pendingIndex}" style="padding:4px;border:1px solid #242424;border-radius:4px;background:#101010;">`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#bbb"><button type="button" class="info-research-stat-matrix-btn" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" data-from-level="${preview.fromLevel}" data-to-level="${preview.toLevel}" style="cursor:pointer;background:#111;color:#9cf;border:1px solid #355;border-radius:3px;padding:0 5px;height:18px;line-height:16px;font-size:10px;">M</button>${thingVisual}<span title="${thing ? thing.label : `${t.kind}:${t.key}`}">${thingTextFallback}${statLabel}</span></span>`;
        html += `<span style="color:#8fc;min-width:54px;text-align:right;display:inline-block;">${queueItemValueLabel}</span>`;
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
        let statLabel = stat ? stat.label : (t.statKey || 'stat');
        let thingVisual = _renderResearchQueueThingIconHtml(thing, 18);
        let thingTextFallback = thing ? '' : `${t.kind}:${t.key} / `;
        let canAfford = !preview.atMax;
        let selectedThingLevel = getResearchPreviewThingLevel();
        let baseValue = getResearchStatValueAtLevel(t.kind, t.key, t.statKey, 0, selectedThingLevel);
        let projectedMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(preview.toValue))
            ? (preview.toValue / baseValue)
            : NaN;

        let pendingIndex = t.isActiveTask ? -1 : (i - ((orderedTasks[0] && orderedTasks[0].isActiveTask) ? 1 : 0));

        html += `<div class="info-research-queue-item" data-owner="${owner}" data-gx="${anchor.gx}" data-gy="${anchor.gy}" data-active="${t.isActiveTask ? '1' : '0'}" data-pending-index="${pendingIndex}" style="padding:4px;border:1px solid #242424;border-radius:4px;background:#101010;">`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#bbb"><button type="button" class="info-research-stat-matrix-btn" data-kind="${t.kind}" data-key="${t.key}" data-stat-key="${t.statKey}" data-from-level="${preview.fromLevel}" data-to-level="${preview.toLevel}" style="cursor:pointer;background:#111;color:#9cf;border:1px solid #355;border-radius:3px;padding:0 5px;height:18px;line-height:16px;font-size:10px;">M</button>${thingVisual}<span title="${thing ? thing.label : `${t.kind}:${t.key}`}">${thingTextFallback}${statLabel}</span></span>`;
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

function getResearchSpentEnergyForAppliedLevels(kind, key, statKey, appliedLevel) {
    let level = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(appliedLevel) || 0)));
    let total = 0;
    for (let i = 0; i < level; i++) {
        total += Math.max(0, Number(getResearchCost(kind, key, statKey, i)) || 0);
    }
    return total;
}

function getResearchQueuedEnergyForStat(kind, key, statKey, startLevel, queuedDepth) {
    let level = Math.max(0, Math.min(MAX_RESEARCH_LEVEL, Math.floor(Number(startLevel) || 0)));
    let depth = Math.max(0, Math.floor(Number(queuedDepth) || 0));
    let total = 0;
    for (let i = 0; i < depth && (level + i) < MAX_RESEARCH_LEVEL; i++) {
        total += Math.max(0, Number(getResearchCost(kind, key, statKey, level + i)) || 0);
    }
    return total;
}

function _normalizeResearchPanelSelectionIds(scopeKey) {
    let raw = researchPanelOpenState[scopeKey];
    let ids = [];
    if (Array.isArray(raw)) ids = raw;
    else if (typeof raw === 'string' && raw) ids = [raw];
    let seen = new Set();
    let filtered = [];
    for (let thingId of ids) {
        let normalizedId = String(thingId || '');
        if (!normalizedId || !RESEARCH_THINGS_BY_ID[normalizedId] || seen.has(normalizedId)) continue;
        seen.add(normalizedId);
        filtered.push(normalizedId);
    }
    if (filtered.length <= 0) {
        let first = RESEARCH_THINGS[0];
        if (first) filtered.push(`${first.kind}:${first.key}`);
    }
    researchPanelOpenState[scopeKey] = filtered;
    return filtered;
}

function setResearchThingPanelSelection(owner, scope, thingId, ev = null) {
    let scopeKey = getResearchPanelScopeKey(owner, scope);
    let current = _normalizeResearchPanelSelectionIds(scopeKey);
    let normalizedThingId = String(thingId || '');
    if (!RESEARCH_THINGS_BY_ID[normalizedThingId]) return current;
    let additive = !!(ev && (ev.shiftKey || ev.ctrlKey || ev.metaKey));
    let next = [];
    if (!additive) {
        next = [normalizedThingId];
    } else if (current.includes(normalizedThingId)) {
        next = current.filter(id => id !== normalizedThingId);
        if (next.length <= 0) next = [normalizedThingId];
    } else {
        next = [...current, normalizedThingId];
    }
    researchPanelOpenState[scopeKey] = next;
    return next;
}

function getResearchThingPanelSelection(owner, scope) {
    let scopeKey = getResearchPanelScopeKey(owner, scope);
    let selectedThingIds = _normalizeResearchPanelSelectionIds(scopeKey);
    let selectedThings = selectedThingIds.map(id => RESEARCH_THINGS_BY_ID[id]).filter(Boolean);
    let selectedThingId = selectedThingIds[0] || '';
    return {
        scopeKey,
        selectedThingIds,
        selectedThings,
        selectedThingId,
        selectedThing: selectedThings[0] || null,
    };
}

function getResearchThingSelectionTitle(selection) {
    if (!selection || !Array.isArray(selection.selectedThings) || selection.selectedThings.length <= 0) return 'Stats';
    if (selection.selectedThings.length === 1) return selection.selectedThings[0].label || 'Stats';
    return `${selection.selectedThings.length} selected`;
}

function getResearchMultiStatGroupKey(stat) {
    let statKey = String(stat && stat.statKey || '');
    if (statKey === 'builderDps' || statKey === 'healerDps' || statKey === 'researcherDps' || statKey === 'gatherPerTrip') {
        return 'workSpeed';
    }
    return statKey;
}

function _formatResearchQueuedLevelLabel(level) {
    return `R${Math.max(0, Math.floor(Number(level) || 0))}`;
}

function _formatResearchQueuedLevelLabelForMany(levels) {
    let normalized = [];
    for (let value of (levels || [])) {
        let level = Math.max(0, Math.floor(Number(value) || 0));
        normalized.push(level);
    }
    if (normalized.length <= 0) return 'R0';
    return normalized.every(v => v === normalized[0]) ? _formatResearchQueuedLevelLabel(normalized[0]) : 'RMIX';
}

function _buildResearchStatSlotHtml(text, widthCh, color = '#9cf', extraStyle = '') {
    let width = Math.max(1, Number(widthCh) || 1);
    return `<span style="color:${color};flex:0 0 ${width}ch;min-width:${width}ch;max-width:${width}ch;text-align:left;display:inline-block;font-variant-numeric:tabular-nums;font-family:Consolas,'Courier New',monospace;overflow:hidden;white-space:nowrap;${extraStyle}">${text}</span>`;
}

function _buildResearchMultiStatEntries(selectedThings) {
    let entries = [];
    let byGroupKey = Object.create(null);
    for (let thing of (selectedThings || [])) {
        if (!thing || !Array.isArray(thing.stats)) continue;
        for (let stat of thing.stats) {
            if (!stat || !stat.statKey) continue;
            let groupKey = getResearchMultiStatGroupKey(stat);
            let entry = byGroupKey[groupKey];
            if (!entry) {
                entry = { groupKey, label: stat.label || String(stat.statKey), items: [] };
                byGroupKey[groupKey] = entry;
                entries.push(entry);
            }
            entry.items.push({ thing, stat });
        }
    }
    return entries;
}

function _renderResearchSingleThingStatsPanel(owner, scope, targetArg, selectedThing, popupLayout = false) {
    let html = '';
    if (!selectedThing) return html;
    let groupCoordStr = Array.isArray(targetArg) ? targetArg.map(r => `${r.gx},${r.gy}`).join(';') : '';
    let panelClasses = popupLayout ? 'research-popup-stat-pane' : '';
    let panelStyle = popupLayout
        ? 'height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;'
        : 'margin-top:4px;border:1px solid #2f2f2f;border-radius:4px;padding:4px;background:#121212';
    html += `<div class="${panelClasses}" style="${panelStyle}">`;
    if (!popupLayout) html += `<div style="font-size:10px;color:#ddd;margin-bottom:3px">${selectedThing.label}</div>`;
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
        if (!Number.isFinite(projectedValue)) projectedValue = currentValue;
        let projectedMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(projectedValue))
            ? (projectedValue / baseValue)
            : NaN;
        let currentMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(currentValue))
            ? (currentValue / baseValue)
            : NaN;
        let nextPreviewLevel = atMax ? displayToLevel : Math.min(MAX_RESEARCH_LEVEL, displayToLevel + 1);
        let nextPreviewValue = getResearchStatValueAtLevel(selectedThing.kind, selectedThing.key, stat.statKey, nextPreviewLevel, selectedThingLevel);
        if (!Number.isFinite(nextPreviewValue)) nextPreviewValue = projectedValue;
        let nextPreviewMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(nextPreviewValue))
            ? (nextPreviewValue / baseValue)
            : NaN;
        let queuedEnergy = getResearchQueuedEnergyForStat(selectedThing.kind, selectedThing.key, stat.statKey, currentLevel, globalQueuedDepth);
        let currentMultiplierLabel = `x${formatResearchMultiplierValue(currentMultiplier)}`;
        let projectedMultiplierLabel = `x${formatResearchMultiplierValue(projectedMultiplier)}`;
        let nextPreviewMultiplierLabel = `x${formatResearchMultiplierValue(nextPreviewMultiplier)}`;
        let queuedLevelLabel = _formatResearchQueuedLevelLabel(displayToLevel);
        if (stat.statKey === 'maxLevel') {
            currentMultiplierLabel = formatResearchStatValue('maxLevel', currentValue);
            projectedMultiplierLabel = formatResearchStatValue('maxLevel', projectedValue);
            nextPreviewMultiplierLabel = formatResearchStatValue('maxLevel', nextPreviewValue);
        }
        html += `<div style="margin:2px 0 6px 0;padding:3px 4px;border:1px solid #242424;border-radius:4px;background:#101010">`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#bbb"><button type="button" class="info-research-stat-matrix-btn" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" data-from-level="${displayFromLevel}" data-to-level="${displayToLevel}" style="cursor:pointer;background:#111;color:#9cf;border:1px solid #355;border-radius:3px;padding:0 5px;height:18px;line-height:16px;font-size:10px;">M</button><span>${stat.label}</span></span>`;
        html += `<span style="color:#fd0">⚡${formatBigNumber(queuedEnergy, 0)}</span>`;
        html += `<span class="info-research-level-preview-btn" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" data-from-level="${displayFromLevel}" data-to-level="${displayToLevel}" style="color:#8fc;cursor:pointer;flex:0 0 auto;text-align:right;display:inline-block;">${currentMultiplierLabel}->${projectedMultiplierLabel}</span>`;
        html += `</div>`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:0.75ch;color:#9cf;flex:1 1 auto;min-width:0">`;
        html += _buildResearchStatSlotHtml(atMax ? 'MAX' : formatInfoCurrency(nextCost), 10, '#fd0');
        html += _buildResearchStatSlotHtml(nextPreviewMultiplierLabel, 5, '#8fc');
        html += _buildResearchStatSlotHtml(`Q:${queuedDepth}`, 4, '#9cf', 'margin-left:1ch;');
        html += _buildResearchStatSlotHtml(queuedLevelLabel, 4, '#9cf');
        html += `</span>`;
        if (scope.startsWith('single:')) {
            html += `<div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:0 0 46px;min-width:46px">`;
            html += `<span class="info-research-dequeue-btn" data-gx="${targetArg.gx}" data-gy="${targetArg.gy}" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" style="cursor:pointer;color:#f66;font-weight:bold;">[-]</span>`;
            html += `<span class="info-research-buy-btn" data-gx="${targetArg.gx}" data-gy="${targetArg.gy}" data-kind="${selectedThing.kind}" data-key="${selectedThing.key}" data-stat-key="${stat.statKey}" style="cursor:${atMax ? 'default' : 'pointer'};color:${canAfford ? '#4f4' : '#242'};font-weight:bold;">[+]</span>`;
            html += `</div>`;
        } else {
            html += `<div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:0 0 46px;min-width:46px">`;
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

function _renderResearchMultiThingStatsPanel(owner, scope, targetArg, selectedThings, popupLayout = false) {
    let html = '';
    let groupCoordStr = Array.isArray(targetArg) ? targetArg.map(r => `${r.gx},${r.gy}`).join(';') : '';
    let panelClasses = popupLayout ? 'research-popup-stat-pane' : '';
    let panelStyle = popupLayout
        ? 'height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;'
        : 'margin-top:4px;border:1px solid #2f2f2f;border-radius:4px;padding:4px;background:#121212';
    let statEntries = _buildResearchMultiStatEntries(selectedThings);
    html += `<div class="${panelClasses}" style="${panelStyle}">`;
    if (!popupLayout) html += `<div style="font-size:10px;color:#ddd;margin-bottom:3px">${selectedThings.length} selected</div>`;
    for (let entry of statEntries) {
        let applicable = entry.items || [];
        if (applicable.length <= 0) continue;
        let selectedThingLevel = getResearchPreviewThingLevel();
        let totalQueuedEnergy = 0;
        let totalNextCost = 0;
        let totalQueuedDepth = 0;
        let projectedResearchLevels = [];
        let currentLabels = [];
        let projectedLabels = [];
        let nextPreviewLabels = [];
        let anyQueueable = false;
        for (let item of applicable) {
            let thing = item.thing;
            let stat = item.stat;
            let currentLevel = getPlayerResearchLevel(owner, thing.kind, thing.key, stat.statKey);
            let globalQueuedDepth = getResearchQueuedDepthForPlayer(owner, thing.kind, thing.key, stat.statKey);
            let projectedLevel = currentLevel + globalQueuedDepth;
            let atMax = projectedLevel >= MAX_RESEARCH_LEVEL;
            let displayFromLevel = currentLevel;
            let displayToLevel = Math.min(MAX_RESEARCH_LEVEL, projectedLevel);
            let currentValue = getResearchStatValueAtLevel(thing.kind, thing.key, stat.statKey, displayFromLevel, selectedThingLevel);
            let projectedValue = getResearchStatValueAtLevel(thing.kind, thing.key, stat.statKey, displayToLevel, selectedThingLevel);
            let baseValue = getResearchStatValueAtLevel(thing.kind, thing.key, stat.statKey, 0, selectedThingLevel);
            if (!Number.isFinite(projectedValue)) projectedValue = currentValue;
            let projectedMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(projectedValue))
                ? (projectedValue / baseValue)
                : NaN;
            let currentMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(currentValue))
                ? (currentValue / baseValue)
                : NaN;
            let nextPreviewLevel = atMax ? displayToLevel : Math.min(MAX_RESEARCH_LEVEL, displayToLevel + 1);
            let nextPreviewValue = getResearchStatValueAtLevel(thing.kind, thing.key, stat.statKey, nextPreviewLevel, selectedThingLevel);
            if (!Number.isFinite(nextPreviewValue)) nextPreviewValue = projectedValue;
            let nextPreviewMultiplier = (Number.isFinite(baseValue) && Math.abs(baseValue) > 1e-9 && Number.isFinite(nextPreviewValue))
                ? (nextPreviewValue / baseValue)
                : NaN;
            totalQueuedEnergy += getResearchQueuedEnergyForStat(thing.kind, thing.key, stat.statKey, currentLevel, globalQueuedDepth);
            totalQueuedDepth += Math.max(0, Number(globalQueuedDepth) || 0);
            projectedResearchLevels.push(displayToLevel);
            if (!atMax) {
                totalNextCost += Math.max(0, Number(getResearchCost(thing.kind, thing.key, stat.statKey, projectedLevel)) || 0);
                anyQueueable = true;
            }
            if (stat.statKey === 'maxLevel') {
                currentLabels.push(formatResearchStatValue('maxLevel', currentValue));
                projectedLabels.push(formatResearchStatValue('maxLevel', projectedValue));
                nextPreviewLabels.push(formatResearchStatValue('maxLevel', nextPreviewValue));
            } else {
                currentLabels.push(`x${formatResearchMultiplierValue(currentMultiplier)}`);
                projectedLabels.push(`x${formatResearchMultiplierValue(projectedMultiplier)}`);
                nextPreviewLabels.push(`x${formatResearchMultiplierValue(nextPreviewMultiplier)}`);
            }
        }
        let currentLabel = currentLabels.every(v => v === currentLabels[0]) ? currentLabels[0] : 'MIX';
        let projectedLabel = projectedLabels.every(v => v === projectedLabels[0]) ? projectedLabels[0] : 'MIX';
        let nextPreviewLabel = nextPreviewLabels.every(v => v === nextPreviewLabels[0]) ? nextPreviewLabels[0] : 'MIX';
        let queuedLevelLabel = _formatResearchQueuedLevelLabelForMany(projectedResearchLevels);
        let costLabel = anyQueueable ? formatInfoCurrency(totalNextCost) : 'MAX';
        let targetAttrs = scope.startsWith('single:')
            ? `data-gx="${targetArg.gx}" data-gy="${targetArg.gy}"`
            : `data-coords="${groupCoordStr}"`;
        let subClass = scope.startsWith('single:') ? 'info-research-dequeue-multi-btn' : 'info-research-dequeue-multi-group-btn';
        let addClass = scope.startsWith('single:') ? 'info-research-buy-multi-btn' : 'info-research-buy-multi-group-btn';
        html += `<div style="margin:2px 0 6px 0;padding:3px 4px;border:1px solid #242424;border-radius:4px;background:#101010">`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:4px;color:#bbb"><span>${entry.label}</span></span>`;
        html += `<span style="color:#fd0">⚡${formatBigNumber(totalQueuedEnergy, 0)}</span>`;
        html += `<span style="color:#8fc;flex:0 0 auto;text-align:right;display:inline-block;">${currentLabel}->${projectedLabel}</span>`;
        html += `</div>`;
        html += `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;white-space:nowrap">`;
        html += `<span style="display:flex;align-items:center;gap:0.75ch;color:#9cf;flex:1 1 auto;min-width:0">`;
        html += _buildResearchStatSlotHtml(costLabel, 10, '#fd0');
        html += _buildResearchStatSlotHtml(nextPreviewLabel, 5, '#8fc');
        html += _buildResearchStatSlotHtml(`Q:${totalQueuedDepth}`, 4, '#9cf', 'margin-left:1ch;');
        html += _buildResearchStatSlotHtml(queuedLevelLabel, 4, '#9cf');
        html += `</span>`;
        html += `<div style="display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:0 0 46px;min-width:46px">`;
        html += `<span class="${subClass}" ${targetAttrs} data-owner="${owner}" data-scope="${scope}" data-stat-group-key="${entry.groupKey}" style="cursor:pointer;color:#f66;font-weight:bold;">[-]</span>`;
        html += `<span class="${addClass}" ${targetAttrs} data-owner="${owner}" data-scope="${scope}" data-stat-group-key="${entry.groupKey}" style="cursor:${anyQueueable ? 'pointer' : 'default'};color:${anyQueueable ? '#4f4' : '#242'};font-weight:bold;">[+]</span>`;
        html += `</div>`;
        html += `</div>`;
        html += `</div>`;
    }
    html += `</div>`;
    return html;
}

function renderResearchThingSelectorButtons(owner, scope, selectedThingId, opts = {}) {
    let html = '';
    let popupLayout = !!opts.popupLayout;
    let selectedThingIds = Array.isArray(opts.selectedThingIds) ? opts.selectedThingIds : [selectedThingId];
    let wrapperStyle = popupLayout
        ? 'display:grid;grid-template-columns:repeat(7, minmax(0, 1fr));gap:6px;align-items:start;'
        : 'display:flex;flex-wrap:wrap;gap:4px;align-items:flex-start';
    html += `<div class="info-row${popupLayout ? ' research-popup-thing-grid' : ''}" style="${wrapperStyle}">`;
    for (let thing of RESEARCH_THINGS) {
        let thingId = `${thing.kind}:${thing.key}`;
        let isSelected = selectedThingIds.includes(thingId);
        let borderRadius = thing.kind === 'unit' ? '50%' : '4px';
        let buttonStyle = popupLayout
            ? `width:100%;height:34px;padding:0;border:2px solid ${isSelected ? '#8cf' : '#333'};border-radius:${borderRadius};background:${isSelected ? '#1a2730' : '#111'};cursor:pointer;display:flex;align-items:center;justify-content:center`
            : `width:32px;height:32px;padding:0;border:2px solid ${isSelected ? '#8cf' : '#333'};border-radius:${borderRadius};background:${isSelected ? '#1a2730' : '#111'};cursor:pointer;display:flex;align-items:center;justify-content:center`;
        html += `<button class="info-research-thing-btn" data-owner="${owner}" data-scope="${scope}" data-thing-id="${thingId}" title="${thing.label}" style="${buttonStyle}">`;
        html += `<img src="${getItemThumbnail(thing.key, 24)}" width="24" height="24" style="display:block;${thing.kind === 'unit' ? 'border-radius:50%;' : ''}">`;
        html += `</button>`;
    }
    html += `</div>`;
    return html;
}

function renderResearchThingStatsPanel(owner, scope, targetArg, selectedThing, opts = {}) {
    let popupLayout = !!opts.popupLayout;
    let selectedThings = Array.isArray(opts.selectedThings) ? opts.selectedThings.filter(Boolean) : (selectedThing ? [selectedThing] : []);
    if (selectedThings.length <= 1) return _renderResearchSingleThingStatsPanel(owner, scope, targetArg, selectedThings[0] || null, popupLayout);
    return _renderResearchMultiThingStatsPanel(owner, scope, targetArg, selectedThings, popupLayout);
}

function renderResearchThingRowsForPanel(owner, scope, targetArg) {
    let html = '';
    let selection = getResearchThingPanelSelection(owner, scope);
    html += renderResearchThingSelectorButtons(owner, scope, selection.selectedThingId, { selectedThingIds: selection.selectedThingIds });
    if (selection.selectedThings.length <= 0) return html;
    html += renderResearchThingStatsPanel(owner, scope, targetArg, selection.selectedThing, { selectedThings: selection.selectedThings });
    return html;
}

function renderResearchThreeColumnLayout(owner, scope, targetArg, queueHtml, queueCount, queueCap) {
    let selection = getResearchThingPanelSelection(owner, scope);
    let html = '';
    html += `<div class="research-popup-three-col">`;
    html += `<div class="research-popup-pane research-popup-selector-pane">`;
    html += `<div class="research-popup-pane-title">Things</div>`;
    html += renderResearchThingSelectorButtons(owner, scope, selection.selectedThingId, { popupLayout: true, selectedThingIds: selection.selectedThingIds });
    html += `</div>`;
    html += `<div class="research-popup-pane research-popup-stats-pane">`;
    html += `<div class="research-popup-pane-title">${getResearchThingSelectionTitle(selection)}</div>`;
    html += renderResearchThingStatsPanel(owner, scope, targetArg, selection.selectedThing, { popupLayout: true, selectedThings: selection.selectedThings });
    html += `</div>`;
    html += `<div class="research-popup-pane research-popup-queue-pane">`;
    html += `<div class="research-popup-pane-title">Queue <span style="color:#9cf">${formatInfoFraction(queueCount, queueCap)}</span></div>`;
    html += `<div class="research-popup-queue-scroll">${queueHtml}</div>`;
    html += `</div>`;
    html += `</div>`;
    return html;
}

function renderResearchInfo(e) {
    let html = '';
    let queueScope = `single:${e.gx},${e.gy}`;
    let queueOpen = isResearchQueuePanelOpen(e.owner, queueScope);
    let queueLen = getResearchQueueTotalLength(e);
    let queueCap = getResearchQueueCapacityForPlayer(e.owner);
    let popupThreeColumnLayout = researchPopupInfoRenderActive;
    let baseVisTiles = getEntityBaseVisibilityRangeTiles(e);
    let effVisTiles = getEntityEffectiveVisibilityRangeTiles(e);
    let baseLevel = e.level || stackCountToLevel(e.stacks || 1);
    let effLevel = getThingEffectiveLevel(e, baseLevel);
    let baseUpKeep = getBuildingStatForOwner(e.owner, e.type, baseLevel, 'upKeep');
    let effUpKeep = getBuildingStatForOwner(e.owner, e.type, effLevel, 'upKeep');
    let baseResearcherUpKeep = getUnitStatForOwner(e.owner, 'researcher_unit', baseLevel, 'upKeep');
    let effResearcherUpKeep = getUnitStatForOwner(e.owner, 'researcher_unit', effLevel, 'upKeep');
    let energyDisplay = formatThingEnergyDisplay(e);
    html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRow(_buildInfoPanelEntityStateLabel(e, true), _getInfoPanelEntityStateLabel(e, true));
    html += infoRow(_buildInfoPanelAssignedLabelButton('entity', { gx: e.gx, gy: e.gy, targetType: e.type || '' }), _buildInfoPanelAssignedWorkersHtml(e));
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    html += infoRow('Visibility', formatRangeStatTiles(baseVisTiles), formatRangeStatTiles(effVisTiles));
    if (Number.isFinite(baseUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(baseUpKeep, 2)}\u26A1/ s`, Number.isFinite(effUpKeep) ? `${formatBigNumber(effUpKeep, 2)}\u26A1/ s` : `${formatBigNumber(baseUpKeep, 2)}\u26A1/ s`);
    }
    if (Number.isFinite(baseResearcherUpKeep)) {
        html += infoRow(withInfoPanelStatMatrixButton('Worker UpKeep', { title: `researcher_unit / UpKeep`, kind: 'unit', key: 'researcher_unit', statKey: 'upKeep' }), `${formatBigNumber(baseResearcherUpKeep, 2)}\u26A1/ s`, Number.isFinite(effResearcherUpKeep) ? `${formatBigNumber(effResearcherUpKeep, 2)}\u26A1/ s` : `${formatBigNumber(baseResearcherUpKeep, 2)}\u26A1/ s`);
    }
    let baseWorkerSearchDistance = getUnitStatForOwner(e.owner, 'researcher_unit', e.level || 1, 'workerSearchDistance');
    let effWorkerSearchDistance = getUnitStatForOwner(e.owner, 'researcher_unit', getThingEffectiveLevel(e), 'workerSearchDistance');
    if (Number.isFinite(baseWorkerSearchDistance)) {
        html += infoRow(withInfoPanelStatMatrixButton('Work Distance', { title: `research / Work Distance`, kind: 'unit', key: 'researcher_unit', statKey: 'workerSearchDistance' }), formatAreaDistanceStat(baseWorkerSearchDistance), Number.isFinite(effWorkerSearchDistance) ? formatAreaDistanceStat(effWorkerSearchDistance) : formatAreaDistanceStat(baseWorkerSearchDistance));
    }
    if (e.owner === localPlayerId) {
        html += infoRow('Rally', e.rallyX !== null ? `(${Math.floor(e.rallyX / TILE)},${Math.floor(e.rallyY / TILE)})` : 'None');
    }
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
        html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
        if (popupThreeColumnLayout) {
            html += renderResearchThreeColumnLayout(
                e.owner,
                queueScope,
                e,
                renderQueuedResearchTasksForSingleBuilding(e),
                queueLen,
                queueCap
            );
        } else {
            html += `<div class="info-row info-research-queue-toggle" data-owner="${e.owner}" data-scope="${queueScope}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center">`;
            html += `<span>Queue</span><span>${queueOpen ? '\u25BE' : '\u25B8'} ${formatInfoFraction(queueLen, queueCap)}</span>`;
            html += `</div>`;
            if (queueOpen) {
                html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
                html += renderQueuedResearchTasksForSingleBuilding(e);
                html += `</div>`;
            }
            html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
            html += renderResearchThingRowsForPanel(e.owner, `single:${e.gx},${e.gy}`, e);
            html += `</div>`;
        }
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
    let popupThreeColumnLayout = researchPopupInfoRenderActive;
    let totalEnergy = 0;
    let totalBaseVis = 0, totalEffVis = 0;
    let totalBaseUpKeep = 0, totalEffUpKeep = 0;
    let totalBaseResearcherUpKeep = 0, totalEffResearcherUpKeep = 0;
    for (let r of group) {
        totalEnergy += r.energy;
        let rBaseLevel = r.level || stackCountToLevel(r.stacks || 1);
        let rEffLevel = getThingEffectiveLevel(r, rBaseLevel);
        totalBaseUpKeep += Number(getBuildingStatForOwner(r.owner, r.type, rBaseLevel, 'upKeep')) || 0;
        totalEffUpKeep += Number(getBuildingStatForOwner(r.owner, r.type, rEffLevel, 'upKeep')) || 0;
        totalBaseResearcherUpKeep += Number(getUnitStatForOwner(r.owner, 'researcher_unit', rBaseLevel, 'upKeep')) || 0;
        totalEffResearcherUpKeep += Number(getUnitStatForOwner(r.owner, 'researcher_unit', rEffLevel, 'upKeep')) || 0;
        totalBaseVis += Number(getEntityBaseVisibilityRangeTiles(r)) || 0;
        totalEffVis += Number(getEntityEffectiveVisibilityRangeTiles(r)) || 0;
    }
    let groupEnergyDisplay = formatThingGroupEnergyDisplay(group);
    let totalQueue = getResearchQueueTotalLength(e);
    let queueCap = getResearchQueueCapacityForPlayer(e.owner);
    html += infoRow('Count', group.length);
    html += infoRow('Energy', groupEnergyDisplay.base, groupEnergyDisplay.effective);
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(e.stacks, e.level, e.effectiveStacks, e.effectiveLevel, getThingManualStacks(e));
    let avgBaseVis = group.length > 0 ? totalBaseVis / group.length : 0;
    let avgEffVis = group.length > 0 ? totalEffVis / group.length : 0;
    html += infoRow('Visibility', `${formatRangeStatTiles(avgBaseVis)} avg`, `${formatRangeStatTiles(avgEffVis)} avg`);
    html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(totalBaseUpKeep, 2)}\u26A1/ s`, `${formatBigNumber(totalEffUpKeep, 2)}\u26A1/ s`);
    html += infoRow(withInfoPanelStatMatrixButton('Worker UpKeep', { title: `researcher_unit / UpKeep`, kind: 'unit', key: 'researcher_unit', statKey: 'upKeep' }), `${formatBigNumber(totalBaseResearcherUpKeep, 2)}\u26A1/ s`, `${formatBigNumber(totalEffResearcherUpKeep, 2)}\u26A1/ s`);
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
    if (e.owner === localPlayerId) {
        let readyGroup = group.filter(r => !r.underConstruction);
        let workerQueueCount = 0;
        for (let r of readyGroup) {
            if (!r || !Array.isArray(r.spawnQueue)) continue;
            workerQueueCount += r.spawnQueue.length;
        }
        let queueReady = readyGroup;
        let workerCoordStr = queueReady.map(r => `${r.gx},${r.gy}`).join(';');
        let queueCostSource = readyGroup[0] || group[0];
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
        html += `<span style="color:#fff;margin:0 6px;">${formatInfoFraction(workerQueueCount, Math.max(1, readyGroup.length) * 10)}</span>`;
        html += `<span>${subBtn} ${addBtn}</span>`;
        html += `</div>`;
        html += renderSpawnerEnergyProgressRow(getSpawnerGroupEnergyProgress(readyGroup));

        html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
        if (popupThreeColumnLayout) {
            html += renderResearchThreeColumnLayout(
                e.owner,
                queueScope,
                group,
                renderQueuedResearchTasksForGroup(group),
                totalQueue,
                queueCap
            );
        } else {
            html += `<div class="info-row info-research-queue-toggle" data-owner="${e.owner}" data-scope="${queueScope}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center">`;
            html += `<span>Queue</span><span>${queueOpen ? '\u25BE' : '\u25B8'} ${formatInfoFraction(totalQueue, queueCap)}</span>`;
            html += `</div>`;

            if (queueOpen) {
                html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
                html += renderQueuedResearchTasksForGroup(group);
                html += `</div>`;
            }
            html += `<div style="margin-top:4px;border-top:1px solid #333;padding-top:4px">`;
            html += renderResearchThingRowsForPanel(e.owner, queueScope, group);
            html += `</div>`;
        }
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

    let queueResearchForSelection = (btn, actionName) => {
        let owner = Number.parseInt(btn.dataset.owner, 10);
        let scope = String(btn.dataset.scope || '');
        let statKey = String(btn.dataset.statKey || '');
        let statGroupKey = String(btn.dataset.statGroupKey || '');
        if (!Number.isFinite(owner) || !scope || (!statKey && !statGroupKey)) return;
        let selection = getResearchThingPanelSelection(owner, scope);
        let targetStats = [];
        for (let thing of selection.selectedThings) {
            if (!thing || !Array.isArray(thing.stats)) continue;
            for (let stat of thing.stats) {
                if (!stat || !stat.statKey) continue;
                if ((statKey && stat.statKey === statKey) || (statGroupKey && getResearchMultiStatGroupKey(stat) === statGroupKey)) {
                    targetStats.push({ thing, statKey: stat.statKey });
                }
            }
        }
        if (targetStats.length <= 0) return;

        let anchor = null;
        if (btn.dataset.gx !== undefined && btn.dataset.gy !== undefined) {
            let gx = Number.parseInt(btn.dataset.gx, 10);
            let gy = Number.parseInt(btn.dataset.gy, 10);
            if (Number.isFinite(gx) && Number.isFinite(gy)) anchor = { gx, gy };
        }
        if (!anchor) {
            let coords = parseCoords(btn.dataset.coords);
            anchor = coords.find(c => {
                let v = getSpawnerAtTile(c.gx, c.gy);
                return !!(v && v.owner === owner && v.energy > 0 && !v.underConstruction && v.type === 'research');
            });
        }
        if (!anchor) return;

        for (let target of targetStats) {
            queueAction({
                action: actionName,
                gx: anchor.gx,
                gy: anchor.gy,
                kind: target.thing.kind,
                key: target.thing.key,
                statKey: target.statKey,
                count: queuePurchaseMultiplier
            });
        }
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
            setResearchThingPanelSelection(owner, scope, thingId, e);
            renderResearchPopupContent();
            return;
        }

        if (btn.classList.contains('info-research-buy-multi-btn') || btn.classList.contains('info-research-buy-multi-group-btn')) {
            queueResearchForSelection(btn, 'queueResearch');
            return;
        }

        if (btn.classList.contains('info-research-dequeue-multi-btn') || btn.classList.contains('info-research-dequeue-multi-group-btn')) {
            queueResearchForSelection(btn, 'dequeueResearch');
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
    let totalBaseUpKeep = 0;
    let totalEffUpKeep = 0;
    let baseStats = calculateItemStats(e.type, baseLevel, e.owner);
    let effStats = calculateItemStats(e.type, effLevel, e.owner);
    let totalEnergy = 0;
    for (let f of group) {
        let fBaseLevel = f.level || stackCountToLevel(f.stacks || 1);
        let fEffLevel = getThingEffectiveLevel(f, fBaseLevel);
        totalBaseUpKeep += Number(getBuildingStatForOwner(f.owner, f.type, fBaseLevel, 'upKeep')) || 0;
        totalEffUpKeep += Number(getBuildingStatForOwner(f.owner, f.type, fEffLevel, 'upKeep')) || 0;
        totalEnergy += (f.energy || 0);
        totalBaseVis += Number(getEntityBaseVisibilityRangeTiles(f)) || 0;
        totalEffVis += Number(getEntityEffectiveVisibilityRangeTiles(f)) || 0;
    }
    let energyDisplay = formatThingGroupEnergyDisplay(group);
    html += infoRow('Count', group.length);
    if (baseStats.maxEnergy > 0) html += infoRow('Energy', energyDisplay.base, energyDisplay.effective);
    html += infoRowLevel('Level', e);
    html += infoRow(withInfoPanelStatMatrixButton('Max Level', { title: `${e.type} / Max Level`, kind: 'building', key: e.type, statKey: 'maxLevel' }), `L${getThingResearchedMaxLevel(e)}`);
    html += infoRowStacks(baseStacks, baseLevel, effStacks, effLevel, getThingManualStacks(e));
    let avgBaseVis = group.length > 0 ? totalBaseVis / group.length : 0;
    let avgEffVis = group.length > 0 ? totalEffVis / group.length : 0;
    html += infoRow('Visibility', `${formatRangeStatTiles(avgBaseVis)} avg`, `${formatRangeStatTiles(avgEffVis)} avg`);
    html += infoRow(withInfoPanelStatMatrixButton('UpKeep', { title: `${e.type} / UpKeep`, kind: 'building', key: e.type, statKey: 'upKeep' }), `${formatBigNumber(totalBaseUpKeep, 2)}\u26A1/ s`, `${formatBigNumber(totalEffUpKeep, 2)}\u26A1/ s`);
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
        let buildingKey = e.type === 'astar_farm' ? 'astar_farm' : 'farm';
        let baseInc = getBuildingStatForOwner(e.owner, buildingKey, baseLevel, 'multiplier');
        let effInc = getBuildingStatForOwner(e.owner, buildingKey, effLevel, 'multiplier');
        if (!Number.isFinite(baseInc)) baseInc = Math.max(1, baseLevel);
        if (!Number.isFinite(effInc)) effInc = Math.max(1, effLevel);
        let gatherLabel = 'x Work Speed';
        html += infoRow(withInfoPanelStatMatrixButton('Multiplier', { title: `${buildingKey} / Multiplier`, kind: 'building', key: buildingKey, statKey: 'multiplier' }), `${baseInc.toFixed(2)}${gatherLabel}`, Math.abs(baseInc - effInc) > 1e-6 ? `${effInc.toFixed(2)}${gatherLabel}` : undefined);
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
    let formatBigNumberSuffixStart = Number.isFinite(opts.formatBigNumberSuffixStart)
        ? Number(opts.formatBigNumberSuffixStart)
        : (panelOverride ? 1000000 : 1000);
    activeFormatBigNumberSuffixStart = formatBigNumberSuffixStart;
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
            if (_isGoldMineLikeEntity(e0) || _isAstarMineLikeEntity(e0)) {
                html += `<div class="info-title">${subgroupPopupBtnHtml}${prefix}${label}</div>`;
            } else {
                let mixedEntityLevels = false;
                if (items.length > 1) {
                    let levelTokens = new Set(items.map(it => getEntityLevelToken(it)));
                    mixedEntityLevels = levelTokens.size > 1;
                }
                html += infoHeader(prefix + label, e0, { mixedLevel: mixedEntityLevels, leftButtonHtml: subgroupPopupBtnHtml });
            }
            if (items.length === 1 && !shouldRenderMixedEntitySubgroupAsGroup(items)) {
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

    let queueResearchForSelectionFromPanel = (btn, actionName) => {
        let owner = Number.parseInt(btn.dataset.owner, 10);
        let scope = String(btn.dataset.scope || '');
        let statKey = String(btn.dataset.statKey || '');
        let statGroupKey = String(btn.dataset.statGroupKey || '');
        if (!Number.isFinite(owner) || !scope || (!statKey && !statGroupKey)) return;
        let selection = getResearchThingPanelSelection(owner, scope);
        let targetStats = [];
        for (let thing of selection.selectedThings) {
            if (!thing || !Array.isArray(thing.stats)) continue;
            for (let stat of thing.stats) {
                if (!stat || !stat.statKey) continue;
                if ((statKey && stat.statKey === statKey) || (statGroupKey && getResearchMultiStatGroupKey(stat) === statGroupKey)) {
                    targetStats.push({ thing, statKey: stat.statKey });
                }
            }
        }
        if (targetStats.length <= 0) return;

        let anchor = null;
        if (btn.dataset.gx !== undefined && btn.dataset.gy !== undefined) {
            let gx = Number.parseInt(btn.dataset.gx, 10);
            let gy = Number.parseInt(btn.dataset.gy, 10);
            if (Number.isFinite(gx) && Number.isFinite(gy)) anchor = { gx, gy };
        }
        if (!anchor) {
            let coords = (btn.dataset.coords || '').split(';').map(c => {
                let [x, y] = c.split(',');
                return { gx: Number.parseInt(x, 10), gy: Number.parseInt(y, 10) };
            }).filter(c => Number.isFinite(c.gx) && Number.isFinite(c.gy));
            anchor = coords.find(c => {
                let v = getSpawnerAtTile(c.gx, c.gy);
                return !!(v && v.owner === owner && v.energy > 0 && !v.underConstruction && v.type === 'research');
            });
        }
        if (!anchor) return;

        for (let target of targetStats) {
            queueAction({
                action: actionName,
                gx: anchor.gx,
                gy: anchor.gy,
                kind: target.thing.kind,
                key: target.thing.key,
                statKey: target.statKey,
                count: queuePurchaseMultiplier
            });
        }
        refreshThisPanel();
    };

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

    panel.querySelectorAll('.info-state-help-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let stateLabel = btn.dataset.stateLabel || 'State';
            let helpText = btn.dataset.helpText || 'Current unit order and why it is happening.';
            setUnitStateHelpPopupOpen(true, stateLabel, helpText);
        });
    });

    panel.querySelectorAll('.info-assigned-unit-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            _selectInfoPanelAssignedUnit(btn.dataset.unitId);
        });
    });

    panel.querySelectorAll('.info-assigned-target-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            _selectInfoPanelAssignedTarget(btn.dataset.targetGx, btn.dataset.targetGy, btn.dataset.targetType || '');
        });
    });

    panel.querySelectorAll('.info-player-status-select-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            selectInfoPanelPlayerRoster(btn.dataset.domain, btn.dataset.filter, btn.dataset.mode || 'all', localPlayerId);
        });
    });

    panel.querySelectorAll('.info-assigned-open-popup-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let mode = String(btn.dataset.mode || '').toLowerCase();
            if (mode === 'worker') {
                _openAssignedInPopupForWorker(btn.dataset.unitId);
                return;
            }
            if (mode === 'entity') {
                _openAssignedInPopupForEntity(btn.dataset.gx, btn.dataset.gy, btn.dataset.targetType || '');
            }
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
        bindInstantPress(btn, (ev) => {
            let owner = Number.parseInt(btn.dataset.owner);
            let scope = btn.dataset.scope;
            let thingId = btn.dataset.thingId;
            if (!Number.isFinite(owner) || !scope || !thingId) return;
            setResearchThingPanelSelection(owner, scope, thingId, ev);
            refreshThisPanel();
        });
    });

    panel.querySelectorAll('.info-research-buy-multi-btn, .info-research-buy-multi-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            queueResearchForSelectionFromPanel(btn, 'queueResearch');
        });
    });

    panel.querySelectorAll('.info-research-dequeue-multi-btn, .info-research-dequeue-multi-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            queueResearchForSelectionFromPanel(btn, 'dequeueResearch');
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
                let marked = (btn.textContent || '').includes('✕');
                queueAction({ action: 'setSalvage', gx, gy, marked: !marked });
            }
            setTimeout(updateInfoPanel, 50);
        });
    });
    // Wire up salvage group buttons
    panel.querySelectorAll('.info-salvage-group-btn').forEach(btn => {
        bindInstantPress(btn, () => {
            let marked = (btn.textContent || '').includes('✕');
            let coords = btn.dataset.coords.split(';').map(c => { let [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; });
            for (let c of coords) queueAction({ action: 'setSalvage', gx: c.gx, gy: c.gy, marked: !marked });
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

function setUnitStateHelpPopupOpen(open, stateLabel = 'State', helpText = '') {
    let popup = document.getElementById('unit-state-help-popup');
    if (!popup) return false;
    let wasOpen = !popup.classList.contains('hidden');
    if (open) {
        let titleEl = document.getElementById('unit-state-help-title');
        let bodyEl = document.getElementById('unit-state-help-body');
        if (titleEl) titleEl.textContent = `${String(stateLabel || 'State')} Help`;
        if (bodyEl) bodyEl.textContent = String(helpText || 'Current unit order and why it is happening.');
    }
    popup.classList.toggle('hidden', !open);
    return wasOpen !== open;
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

let researchPopupInfoRenderActive = false;

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
    researchPopupInfoRenderActive = true;
    try {
        updateInfoPanel(infoPanel, {
            formatBigNumberSuffixStart: 1000,
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
    } finally {
        researchPopupInfoRenderActive = false;
    }

    selectedUnits = prevUnits;
    selectedEntities = prevEntities;
    updateIgnoreLevelButton();
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

function renderGameGraph(metric = graphMetric) {
    let metricDefs = {
        units: { title: 'Units', yTitle: 'UNITS' },
        workers: { title: 'Workers', yTitle: 'WORKERS' },
        combat: { title: 'Combat Units', yTitle: 'COMBAT UNITS' },
        idleWorkers: { title: 'Idle Workers', yTitle: 'IDLE WORKERS' },
        structures: { title: 'Structures', yTitle: 'STRUCTURES' },
        pop: { title: 'Population', yTitle: 'POPULATION' },
        energy: { title: 'Energy', yTitle: 'ENERGY' },
        astar: { title: 'A*', yTitle: 'A*' }
    };
    metric = metricDefs[metric] ? metric : 'units';
    graphMetric = metric;
    let metricDef = metricDefs[metric];
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
            title: metricDef.yTitle,
            rangemode: 'normal',
            gridcolor: '#2a2a2a',
            zerolinecolor: '#333'
        },
        title: { text: metricDef.title, font: { size: 12, color: '#cfd8dc' } }
    }, {
        displayModeBar: false,
        responsive: true
    });
}


