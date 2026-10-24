// Compact, single-row sliders. A gesture submits once on release;
// simulation commands retain their existing integer semantics.
let activeCountBar = null;
let countBarEventsBound = false;
const spawnBarAhead = new Map();
let countTooltipInput = null;
let countTooltipElement = null;
let countTooltipPoint = null;
// Slider tooltips show only while Ctrl or Shift is held over a slider.
let countCtrlHeld = false;
let countHoverInput = null;

function countBarBusy(root) {
    return !!(activeCountBar && activeCountBar.isConnected && root && root.contains(activeCountBar));
}

function countBarLabel(value, prefix) {
    return prefix === 'L' ? `L${value} · ${formatBigNumber(2 ** (value - 1))}` : `${prefix || ''}${value}`;
}

function countBarHtml(value, min, max, spec, label, prefix = '', disabled = false, others = []) {
    bindCountBarEvents();
    // Uncapped building presets retain imported values above the UI range.
    if (!Number.isFinite(max)) max = Math.max(65536, value);
    value = Math.max(min, Math.min(max, Math.floor(value)));
    const top = Math.max(value, ...others);
    const text = top > value ? `${prefix}${value}–${prefix}${top}` : countBarLabel(value, prefix);
    const position = (value - min) / Math.max(1, max - min) * 100;
    const floor = spec.type === 'research' ? Math.min(...spec.stats.map(stat => getPlayerResearchLevel(spec.owner, stat.kind, stat.key, stat.statKey))) : min;
    const locked = Math.max(0, Math.min(100, (floor - min) / Math.max(1, max - min) * 100));
    const itemPosition = Number.isFinite(spec.itemLevel) ? Math.max(0, Math.min(100, (spec.itemLevel - min) / Math.max(1, max - min) * 100)) : null;
    let marker = others.filter(v => v > value).map(v => `<span class="count-other-thumb" style="left:calc((100% - 4px) * ${(v - min) / Math.max(1, max - min)})"></span>`).join('');
    marker += itemPosition === null ? '' : `<span class="count-item-marker" style="left:calc(2px + (100% - 4px) * ${itemPosition / 100})" role="img" aria-label="This queue item: R${spec.itemLevel}"></span>`;
    return `<span class="count-control" style="--position:${position}%;--locked:${locked}%" data-label-side="${position < 40 ? 'after' : 'before'}" data-edge="${position <= 10 ? 'min' : position >= 90 ? 'max' : ''}"><input class="count-slider" type="range" min="${min}" max="${max}" step="1" value="${value}" data-floor="${floor}" data-count-spec="${_escapeHtml(JSON.stringify(spec))}" data-prefix="${prefix}" data-label="${_escapeHtml(label)}" title="" aria-label="${_escapeHtml(label)}" aria-valuetext="${_escapeHtml(text)}"${disabled || max <= min ? ' disabled' : ''}>${marker}<span class="count-min">${prefix}${min}</span><output>${text}</output><span class="count-max">${prefix}${max}</span></span>`;
}

function countControlTooltipHtml(spec, value, label, prefix, baseline) {
    const cell = (className, text) => `<span class="${className}">${_escapeHtml(text)}</span>`;
    if (spec.type === 'research' || spec.type === 'preset-research') {
        const stats = spec.stats || [{ ...parseStartingThingId(spec.thingId), statKey: spec.statKey }];
        let html = '<div class="count-tooltip-things">';
        for (const stat of stats) {
            html += '<div class="count-tooltip-thing">';
            if (stats.length > 1) {
                const thing = getResearchThing(stat.kind, stat.key);
                const entry = getResearchStatEntry(stat.kind, stat.key, stat.statKey);
                html += `<div class="count-tooltip-heading">${_escapeHtml((thing ? thing.label : stat.key) + ' · ' + (entry ? entry.label : stat.statKey))}</div>`;
            }
            const current = spec.type === 'research' ? getPlayerResearchLevel(spec.owner, stat.kind, stat.key, stat.statKey) : baseline;
            const target = Math.max(current, value);
            // Presets may decrease research. In-game research cannot undo
            // completed levels; the middle column belongs to this exact task.
            const selected = spec.type === 'preset-research' ? value : target;
            const hasItem = Number.isFinite(spec.itemLevel);
            html += `<div class="count-tooltip-table${hasItem ? ' has-item' : ''}">`;
            for (let level = 1; level <= researchMatrixThingLevels(stat.kind, stat.key); level++) {
                const at = research => formatResearchStatValue(stat.statKey, getResearchStatValueAtLevel(stat.kind, stat.key, stat.statKey, research, level));
                html += cell('count-tooltip-level', `L${level}:`) + cell('count-tooltip-current', at(current));
                if (hasItem) html += cell('count-tooltip-arrow', '->') + cell('count-tooltip-item', at(spec.itemLevel));
                html += cell('count-tooltip-arrow', '->') + cell('count-tooltip-target', at(selected));
            }
            html += '</div></div>';
        }
        return html + '</div>';
    }
    return `<div class="count-tooltip-heading">${_escapeHtml(label)}</div><div class="count-tooltip-simple">`
        + cell('count-tooltip-current', countBarLabel(baseline, prefix)) + cell('count-tooltip-arrow', '->')
        + cell('count-tooltip-target', countBarLabel(value, prefix)) + '</div>';
}

function hideCountTooltip() {
    if (countTooltipInput) countTooltipInput.removeAttribute('aria-describedby');
    countTooltipInput = null;
    if (countTooltipElement) countTooltipElement.hidden = true;
}

function showCountTooltip(input, event = null) {
    if (event && Number.isFinite(event.clientX)) countTooltipPoint = { x: event.clientX, y: event.clientY };
    if (!input || !input.isConnected || !countCtrlHeld || !(input === countHoverInput || input === activeCountBar
        || (countTooltipElement && !countTooltipElement.hidden && countTooltipElement.matches(':hover')))) { hideCountTooltip(); return; }
    if (!countTooltipElement) {
        countTooltipElement = document.createElement('div');
        countTooltipElement.id = 'count-slider-tooltip';
        countTooltipElement.setAttribute('role', 'tooltip');
        countTooltipElement.addEventListener('pointerleave', () => {
            if (!activeCountBar && countTooltipInput && !countTooltipInput.matches(':hover')) hideCountTooltip();
        });
        document.body.appendChild(countTooltipElement);
    }
    if (countTooltipInput && countTooltipInput !== input) countTooltipInput.removeAttribute('aria-describedby');
    countTooltipInput = input;
    input.setAttribute('aria-describedby', 'count-slider-tooltip');
    const preview = countTooltipPoint ? countSliderValueAtPoint(input, countTooltipPoint.x) : Number(input.value);
    const html = countControlTooltipHtml(JSON.parse(input.dataset.countSpec), preview, input.dataset.label,
        input.dataset.prefix, Number(input.getAttribute('value')));
    if (countTooltipElement._html !== html) {
        countTooltipElement.innerHTML = html;
        countTooltipElement._html = html;
    }
    countTooltipElement.hidden = false;
    const rect = input.getBoundingClientRect();
    const point = countTooltipPoint || { x: rect.left + rect.width / 2, y: rect.top };
    const width = countTooltipElement.offsetWidth, height = countTooltipElement.offsetHeight;
    const left = Math.max(4, Math.min(window.innerWidth - width - 4, point.x + 14));
    const above = rect.top - height - 6;
    const top = above >= 4 ? above : Math.max(4, Math.min(window.innerHeight - height - 4, rect.bottom + 6));
    countTooltipElement.style.left = left + 'px';
    countTooltipElement.style.top = top + 'px';
}

function countSliderValueAtPoint(input, clientX, enforceFloor = true) {
    const rect = input.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left - 2) / Math.max(1, rect.width - 4)));
    const min = Number(input.min), max = Number(input.max), step = Number(input.step) || 1;
    return Math.max(enforceFloor ? Number(input.dataset.floor) || min : min, Math.min(max, min + Math.round((max - min) * fraction / step) * step));
}

function spawnBarOptions(coords, worker) {
    return _getGroupSpawnQueueOptions(coords, worker).map(o => {
        const key = `${worker ? 1 : 0}:${o.gx},${o.gy}`;
        const pending = spawnBarAhead.get(key);
        if (pending) {
            const got = o.len - pending.base;
            if (performance.now() - pending.at > RESEARCH_AHEAD_MS ||
                (got && ((got > 0) !== (pending.delta > 0) || Math.abs(got) >= Math.abs(pending.delta)))) {
                spawnBarAhead.delete(key);
            } else {
                pending.base = o.len;
                pending.delta -= got;
                o.len = Math.max(0, Math.min(worker ? 10 : 20, o.len + pending.delta));
            }
        }
        return { ...o, key, initial: o.len };
    });
}

// (A big group's bar: its count from a sample of its producers, scaled
// (infoGroupSample); its coordinates by token, not as JSON in the markup:
// 190k producers were ~4 MB of attribute each time the panel was made.)
const SPAWN_BAR_COORDS_INLINE_MAX = 512;
function _spawnSpecCoords(spec) {
    if (spec.coords) return spec.coords;
    return typeof infoCoordText === 'function' ? infoCoordText(spec.coordsRef).split(';').filter(Boolean).map(c => { const [x, y] = c.split(','); return { gx: parseInt(x), gy: parseInt(y) }; }) : [];
}
function spawnCountBar(targets, worker) {
    const sample = typeof infoGroupSample === 'function' ? infoGroupSample(targets) : targets;
    const options = spawnBarOptions(sample.map(o => ({ gx: o.gx, gy: o.gy })), worker);
    // (A sampled panel group's targets: infoGroupLen its count, its tiles by token.)
    const len = typeof infoGroupLen === 'function' ? infoGroupLen(targets) : targets.length;
    const scale = sample.length ? len / sample.length : 1;
    const n = scale === 1 ? options.length : Math.round(options.length * scale);
    const spec = targets._all !== undefined && typeof infoGroupCoordAttr === 'function'
        ? { type: 'spawn', coordsRef: infoGroupCoordAttr(targets), worker }
        : targets.length > SPAWN_BAR_COORDS_INLINE_MAX && typeof infoCoordAttr === 'function'
        ? { type: 'spawn', coordsRef: infoCoordAttr(targets.map(o => o.gx + ',' + o.gy).join(';')), worker }
        : { type: 'spawn', coords: targets.map(o => ({ gx: o.gx, gy: o.gy })), worker };
    return countBarHtml(Math.round(options.reduce((m, o) => m + o.len, 0) * scale), 0,
        n * (worker ? 10 : 20), spec, worker ? 'Worker queue count' : 'Unit queue count', '', !options.length);
}

function spawnQueueEnergyEstimate(targets, worker) {
    // (A big group: a sample of it, scaled.)
    const sample = typeof infoGroupSample === 'function' ? infoGroupSample(targets) : targets;
    if (sample !== targets) return spawnQueueEnergyEstimate(sample, worker) * (targets.length / sample.length);
    // (A sampled panel group: its sample, scaled to its count.)
    if (targets._n !== undefined && targets.length) { const t = targets.slice(); return spawnQueueEnergyEstimate(t, worker) * (targets._n / targets.length); }
    let total = 0;
    for (const option of spawnBarOptions(targets, worker)) {
        const producer = worker ? getSpawnerAtTile(option.gx, option.gy) : getBarrackAtTile(option.gx, option.gy);
        if (!producer) continue;
        const queue = producer.spawnQueue || [];
        const fallback = getSpawnerFallbackUnitType(producer);
        const level = getThingBaseLevel(producer);
        let cost = 0;
        for (const item of queue) {
            const spawn = getQueuedSpawnInfo(item, fallback, level, producer.owner);
            cost += Math.max(0, spawn.energyRequired - spawn.energyPaid);
        }
        // Commands still in transit use the next spawn's cost as an estimate.
        const next = getQueuedSpawnInfo(null, fallback, level, producer.owner);
        total += Math.max(0, cost + (option.len - queue.length) * next.energyRequired);
    }
    return total;
}

function setSpawnBarCount(spec, target) {
    const options = spawnBarOptions(_spawnSpecCoords(spec), spec.worker);
    const cap = spec.worker ? 10 : 20;
    target = Math.max(0, Math.min(cap * options.length, Math.floor(target)));
    let delta = target - options.reduce((n, o) => n + o.len, 0);
    // Preserve the existing shortest/longest queue distribution. Batch the
    // resulting delta per producer into one existing multiplayer command.
    const step = Math.sign(delta);
    for (let level = step > 0 ? 0 : cap; delta && level >= 0 && level <= cap; level += step) {
        for (const o of options) {
            if (!delta) break;
            if (o.len !== level || (step > 0 ? level >= cap : level <= 0)) continue;
            o.len += step; delta -= step;
        }
    }
    for (const o of options) {
        const change = o.len - o.initial;
        if (!change) continue;
        const old = spawnBarAhead.get(o.key);
        spawnBarAhead.set(o.key, { base: old ? old.base : o.initial,
            delta: (old ? old.delta : 0) + change, at: performance.now() });
        queueAction({ action: change > 0 ? (spec.worker ? 'queueWorker' : 'queueUnit') :
            (spec.worker ? 'dequeueWorker' : 'dequeueUnit'), gx: o.gx, gy: o.gy, count: Math.abs(change) });
    }
}

function researchBarLevel(owner, stat) {
    const level = getPlayerResearchLevel(owner, stat.kind, stat.key, stat.statKey);
    const depth = getResearchQueuedDepthForPlayer(owner, stat.kind, stat.key, stat.statKey);
    return { level, target: Math.min(MAX_RESEARCH_LEVEL, level + depth +
        (owner === localPlayerId ? researchOrdersAhead(stat.kind, stat.key, stat.statKey, depth) : 0)) };
}

function researchCountBar(owner, targets, stats, itemLevel = null) {
    const coords = (Array.isArray(targets) ? targets : [targets]).filter(Boolean).map(o => ({ gx: o.gx, gy: o.gy }));
    const levels = stats.map(s => researchBarLevel(owner, s));
    const value = Math.min(...levels.map(s => s.target));
    const others = [...new Set(levels.map(s => s.target))].filter(v => v !== value);
    return countBarHtml(value, 0, MAX_RESEARCH_LEVEL, { type: 'research', owner, coords, stats, itemLevel },
        `${others.length ? 'Mixed targets — set all selected stats to' : 'Research target'} level (completed research is kept)`, 'R', owner !== localPlayerId || !coords.length, others);
}

function commitCountBar(input) {
    const spec = JSON.parse(input.dataset.countSpec);
    let value = Math.floor(Number(input.value === undefined ? input.dataset.value : input.value));
    if (!Number.isFinite(value)) return;
    const min = Number(input.min === undefined ? input.dataset.min : input.min);
    const max = input.max === undefined ? input.dataset.max : input.max;
    value = Math.max(min, max ? Math.min(Number(max), value) : value);
    if (spec.type === 'build') {
        buildPurchaseMultiplier = 2 ** (value - 1);
        updatePurchaseMultiplierBars();
        updateBuildMenu();
    } else if (spec.type === 'spawn') {
        setSpawnBarCount(spec, value);
    } else if (spec.type === 'research') {
        if (spec.owner !== localPlayerId) return;
        const anchor = spec.coords.find(c => {
            const r = getSpawnerAtTile(c.gx, c.gy);
            return r && r.owner === localPlayerId && r.type === 'research' && r.energy > 0 && !r.underConstruction;
        });
        if (!anchor) return;
        for (const stat of spec.stats) {
            const current = researchBarLevel(localPlayerId, stat);
            const delta = Math.max(current.level, Math.min(MAX_RESEARCH_LEVEL, value)) - current.target;
            if (!delta) continue;
            const action = { action: delta > 0 ? 'queueResearch' : 'dequeueResearch', ...anchor, ...stat, count: Math.abs(delta) };
            // Dragging a thing into the bottom research bar still inserts at
            // that position. The same bar elsewhere appends as before.
            if (typeof bb !== 'undefined' && bb.menu && bb.menu.el.contains(input)) {
                if (bb.menu.type === 'drop') {
                    if (delta > 0) action.insertAt = bb.menu.insertAt + bb.menu.added;
                    const room = getResearchQueueCapacityForPlayer(localPlayerId) - getPlayerResearchQueueTotalLength(localPlayerId);
                    bb.menu.added = Math.max(0, bb.menu.added + (delta > 0 ? Math.min(delta, room) : delta));
                } else if (bb.menu.type === 'task' && delta > 0) {
                    action.insertAt = _bbMenuTaskIndex(_bbOrderedTasks(localPlayerId)) + 1;
                }
            }
            queueAction(action);
        }
    } else if (spec.type === 'preset-research' || spec.type === 'preset-spawn') {
        if (isMultiplayer && !isHost) return;
        if (spec.type === 'preset-research') setStartingResearchLevel(spec.thingId, spec.statKey, value);
        else setStartingSpawnCount(spec.thingId, spec.level, value);
        renderStartingResourcesPopupContent();
    }
    if (typeof requestInfoPanelRefresh === 'function') requestInfoPanelRefresh(0);
    if (typeof bottomBarRefreshNow === 'function') bottomBarRefreshNow();
}

function bindCountBarEvents() {
    if (countBarEventsBound || typeof document === 'undefined' || !document.addEventListener) return;
    countBarEventsBound = true;
    const isSlider = el => el && el.matches && el.matches('.count-slider');
    const release = () => { activeCountBar = null; };
    document.addEventListener('pointerover', ev => {
        countCtrlHeld = ev.ctrlKey || ev.shiftKey;
        if (isSlider(ev.target)) { countHoverInput = ev.target; showCountTooltip(ev.target, ev); }
    });
    document.addEventListener('pointerout', ev => {
        if (ev.target === countHoverInput) countHoverInput = null;
        if (ev.target === countTooltipInput && !activeCountBar && !(countTooltipElement && ev.relatedTarget && countTooltipElement.contains(ev.relatedTarget))) hideCountTooltip();
    });
    document.addEventListener('pointermove', ev => {
        countCtrlHeld = ev.ctrlKey || ev.shiftKey;
        if (isSlider(ev.target)) countHoverInput = ev.target;
        if (activeCountBar) showCountTooltip(activeCountBar, ev);
        else if (isSlider(ev.target)) showCountTooltip(ev.target, ev);
    });
    document.addEventListener('pointerdown', ev => {
        if (isSlider(ev.target)) {
            if (countSliderValueAtPoint(ev.target, ev.clientX, false) < Number(ev.target.dataset.floor)) {
                ev.preventDefault();
                showCountTooltip(ev.target, ev);
                return;
            }
            activeCountBar = ev.target;
            showCountTooltip(ev.target, ev);
        } else if (!(countTooltipElement && countTooltipElement.contains(ev.target))) hideCountTooltip();
    }, true);
    document.addEventListener('pointerup', () => setTimeout(() => {
        const input = activeCountBar;
        release();
        // A mixed bar released on its lowest target fires no native change,
        // but the gesture still sets every stat to that target.
        if (input && input.isConnected && input.parentElement.querySelector('.count-other-thumb')) {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (countTooltipInput && (!countTooltipInput.isConnected || !countTooltipInput.matches(':hover'))) hideCountTooltip();
    }, 0), true);
    document.addEventListener('pointercancel', () => { release(); hideCountTooltip(); }, true);
    window.addEventListener('blur', () => { release(); countCtrlHeld = false; hideCountTooltip(); });
    window.addEventListener('keydown', ev => {
        if (ev.key === 'Control' || ev.key === 'Shift') {
            countCtrlHeld = true;
            if (countHoverInput && countHoverInput.isConnected) showCountTooltip(countHoverInput);
        } else if (ev.key === 'Escape') hideCountTooltip();
    }, true);
    window.addEventListener('keyup', ev => {
        if (ev.key === 'Control' || ev.key === 'Shift') {
            countCtrlHeld = ev.ctrlKey || ev.shiftKey;
            if (!countCtrlHeld) hideCountTooltip();
        }
    }, true);
    document.addEventListener('scroll', ev => {
        if (!activeCountBar && !(countTooltipElement && countTooltipElement.contains(ev.target))) hideCountTooltip();
    }, true);
    document.addEventListener('input', ev => {
        const input = ev.target;
        if (!isSlider(input)) return;
        activeCountBar = input;
        input.parentElement.classList.add('count-dragging');
        input.value = Math.max(Number(input.dataset.floor) || Number(input.min), Number(input.value));
        const output = input.parentElement.querySelector('output');
        if (input._originalOutput === undefined) input._originalOutput = output.textContent;
        const value = Number(input.value);
        output.textContent = countBarLabel(value, input.dataset.prefix);
        positionCountSliderLabel(input);
        input.setAttribute('aria-valuetext', output.textContent);
        showCountTooltip(input);
    });
    document.addEventListener('change', ev => {
        const input = ev.target;
        if (!isSlider(input)) return;
        input.value = Math.max(Number(input.dataset.floor) || Number(input.min), Number(input.value));
        // Restore the cached text before the normal in-place panel patch.
        if (input._originalOutput !== undefined) {
            input.parentElement.querySelector('output').textContent = input._originalOutput;
            delete input._originalOutput;
        }
        input.parentElement.classList.remove('count-dragging');
        release();
        commitCountBar(input);
        refreshCountControlPanels();
        syncCountSliderValues(document);
        if (countTooltipInput && !countTooltipInput.isConnected) hideCountTooltip();
    });
    document.addEventListener('focusout', ev => { if (isSlider(ev.target)) { release(); hideCountTooltip(); } });
}

function syncCountSliderValues(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.count-slider').forEach(input => {
        if (input !== activeCountBar) {
            input.value = input.getAttribute('value');
            positionCountSliderLabel(input);
        }
    });
    if (countTooltipInput && !countTooltipInput.isConnected) hideCountTooltip();
    else if (countTooltipInput && root.contains(countTooltipInput)) showCountTooltip(countTooltipInput);
}

function positionCountSliderLabel(input) {
    const position = (Number(input.value) - Number(input.min)) / Math.max(1, Number(input.max) - Number(input.min)) * 100;
    input.parentElement.style.setProperty('--position', position + '%');
    input.parentElement.dataset.labelSide = position < 40 ? 'after' : 'before';
    input.parentElement.dataset.edge = position <= 10 ? 'min' : position >= 90 ? 'max' : '';
}

function refreshCountControlPanels() {
    if (!gameStarted) return;
    updateInfoPanel();
    const popup = document.getElementById('research-popup');
    if (popup && !popup.classList.contains('hidden')) renderResearchPopupContent();
    if (typeof bb !== 'undefined' && bb.menu) _bbRenderMenu(true);
}
